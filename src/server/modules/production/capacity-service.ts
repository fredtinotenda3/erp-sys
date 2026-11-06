// Capacity visibility (Milestone 4, mandate §6): "capacity visibility,
// material availability, shortage identification, scheduling" -- NOT
// finite-capacity scheduling. This report does simple date-bucketed load
// (sum of planned setup+run minutes per work centre per day) against each
// work centre's configured dailyCapacityMinutes, if any. It does not
// sequence work, does not account for machine-level contention within a
// work centre, and does not consider shift calendars, breaks, or operator
// availability. A work centre with no dailyCapacityMinutes configured shows
// assigned load with no utilisation percentage, rather than a guessed one.
//
// Source of the load: ProductionJobStage rows for OPEN jobs (planned,
// released, in_progress, on_hold) that have a workCentreId and at least one
// of plannedStart/plannedEnd set, using expectedSetupMinutes +
// expectedRunMinutes (defaulting missing figures to 0 -- a stage with
// neither estimated contributes no load, which is honest: there is nothing
// to report, not a guess of "average load").
//
// This deliberately does NOT introduce a separate ProductionPlan/
// ProductionDemand model. ProductionJob already models "what manufacturing
// work is planned, in what sequence, with what priority and dates" via its
// own status/plannedStart/plannedEnd/priority fields (job-service.ts);
// adding a second entity to represent the same concept would create two
// competing sources of truth for "what's planned", which the mandate's
// stock-ledger section explicitly warns against in spirit (ARCHITECTURE.md
// §5) even though that warning is written about inventory specifically.
import { z } from "zod";
import { prisma } from "../../shared/db";
import { assertCapability, assertBranchAccess } from "../../shared/authz";
import { ValidationError } from "../../shared/errors";
import type { AuthenticatedSession } from "../iam/session-service";
import { findWorkCentreInScope } from "./machine-service";

const OPEN_JOB_STATUSES = ["planned", "released", "in_progress", "on_hold"] as const;

const filterSchema = z.object({
  branchId: z.string().uuid().optional(),
  workCentreId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getCapacityVisibility(session: AuthenticatedSession, input: unknown = {}) {
  assertCapability(session.role, "machine:read");
  assertCapability(session.role, "production_job:read");
  const parsed = filterSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid filter", parsed.error.issues);
  const f = parsed.data;
  if (f.from && f.to && f.to < f.from) throw new ValidationError("`to` cannot be before `from`");

  if (f.workCentreId) {
    const wc = await findWorkCentreInScope(session, f.workCentreId);
    if (!wc) throw new ValidationError("workCentreId does not belong to a work centre you can access");
  }
  if (f.branchId) assertBranchAccess(session, f.branchId);

  const from = f.from ?? new Date(Date.now() - 24 * 60 * 60 * 1000); // default window: yesterday .. +14 days
  const to = f.to ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const workCentres = await prisma.workCentre.findMany({
    where: {
      orgId: session.orgId,
      isActive: true,
      ...(f.workCentreId ? { id: f.workCentreId } : {}),
      ...(f.branchId ? { branchId: f.branchId } : session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } }),
    },
    select: { id: true, code: true, name: true, branchId: true, dailyCapacityMinutes: true },
    orderBy: [{ branchId: "asc" }, { code: "asc" }],
  });
  if (workCentres.length === 0) return { from: from.toISOString(), to: to.toISOString(), workCentres: [] };

  const stages = await prisma.productionJobStage.findMany({
    where: {
      orgId: session.orgId,
      workCentreId: { in: workCentres.map((w) => w.id) },
      job: { status: { in: [...OPEN_JOB_STATUSES] } },
      OR: [{ plannedStart: { not: null } }, { plannedEnd: { not: null } }],
    },
    select: {
      workCentreId: true,
      plannedStart: true,
      plannedEnd: true,
      expectedSetupMinutes: true,
      expectedRunMinutes: true,
      status: true,
      jobId: true,
      stageName: true,
      job: { select: { jobNumber: true, priority: true } },
    },
  });

  // Bucket each stage onto every day in [plannedStart, plannedEnd] (inclusive)
  // that also falls in the requested window -- a stage with only one of the
  // two dates set is bucketed onto that single day.
  type Bucket = { minutes: number; stageCount: number; jobs: Set<string> };
  const byWorkCentreDay = new Map<string, Map<string, Bucket>>();
  for (const s of stages) {
    if (!s.workCentreId) continue;
    const start = s.plannedStart ?? s.plannedEnd!;
    const end = s.plannedEnd ?? s.plannedStart!;
    const minutes = (s.expectedSetupMinutes ?? 0) + (s.expectedRunMinutes ?? 0);
    if (minutes <= 0) continue;
    const perDayMap = byWorkCentreDay.get(s.workCentreId) ?? new Map<string, Bucket>();
    byWorkCentreDay.set(s.workCentreId, perDayMap);
    const cursor = new Date(Math.max(start.getTime(), from.getTime()));
    const endClamped = new Date(Math.min(end.getTime(), to.getTime()));
    if (cursor > endClamped) continue;
    const dayCount = Math.max(1, Math.round((endClamped.getTime() - cursor.getTime()) / 86400000) + 1);
    // Spread the stage's total minutes evenly across the days it spans --
    // a simple, honest approximation (not a claim of hour-by-hour scheduling).
    const perDay = minutes / dayCount;
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(cursor.getTime() + i * 86400000);
      const k = dayKey(d);
      const b = perDayMap.get(k) ?? { minutes: 0, stageCount: 0, jobs: new Set<string>() };
      b.minutes += perDay;
      b.stageCount += 1;
      b.jobs.add(s.job.jobNumber);
      perDayMap.set(k, b);
    }
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    note: "Simple date-bucketed assigned load vs. configured daily capacity -- not finite-capacity scheduling.",
    workCentres: workCentres.map((wc) => {
      const perDayMap = byWorkCentreDay.get(wc.id) ?? new Map<string, Bucket>();
      const days = [...perDayMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, b]) => ({
          date,
          assignedMinutes: Math.round(b.minutes),
          stageCount: b.stageCount,
          jobNumbers: [...b.jobs].sort(),
          capacityMinutes: wc.dailyCapacityMinutes,
          utilisationPct: wc.dailyCapacityMinutes ? Math.round((b.minutes / wc.dailyCapacityMinutes) * 1000) / 10 : null,
          overCapacity: wc.dailyCapacityMinutes ? b.minutes > wc.dailyCapacityMinutes : null,
        }));
      return { id: wc.id, code: wc.code, name: wc.name, branchId: wc.branchId, dailyCapacityMinutes: wc.dailyCapacityMinutes, days };
    }),
  };
}
