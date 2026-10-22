// Pure shop-floor accounting: how output, rework and inspections add up, what
// must hold, and what blocks a stage or job from being completed. No I/O, so the
// same rules judge a new entry, a void, a stage completion and a job completion.
//
// Vocabulary (all quantities are in the PRODUCT's unit of measure):
//   good            units produced and passed on
//   scrap           units written off
//   rework          units sent back to be fixed (not good, not scrap yet)
//   rework_good     of the good units in an entry, how many came back from rework
//   rework_scrap    of the scrap units in an entry, how many were being reworked
//   reclassified    units earlier counted good that a quality disposition has
//                   moved to scrap/rework (created only by dispositions)
//
//   effective good  = sum(good) - sum(reclassified)
//   rework open     = sum(rework) - sum(rework_good) - sum(rework_scrap)
import { Prisma } from "../../../generated/prisma/client";

const Z = new Prisma.Decimal(0);
const D = (v: unknown) => new Prisma.Decimal(String(v));

export interface OutputRow {
  jobStageId: string | null;
  goodQty: Prisma.Decimal;
  scrapQty: Prisma.Decimal;
  reworkQty: Prisma.Decimal;
  reworkGoodQty: Prisma.Decimal;
  reworkScrapQty: Prisma.Decimal;
  reclassifiedFromGoodQty: Prisma.Decimal;
}

export interface InspectionRow {
  jobStageId: string | null;
  producedQty: Prisma.Decimal; // units inspected
  acceptedQty: Prisma.Decimal;
  rejectedQty: Prisma.Decimal;
  dispositionedQty: Prisma.Decimal;
}

export interface OutputTotals {
  grossGood: string;
  effectiveGood: string;
  scrap: string;
  rework: string;
  reworkOpen: string;
  reclassified: string;
  /** units processed = good (gross) + scrap + rework  */
  processed: string;
  /** effectiveGood / processed x 100, 1dp. null when nothing was processed. */
  yieldPercent: string | null;
}

export function totalsOf(rows: OutputRow[]): OutputTotals {
  const sum = (f: (r: OutputRow) => Prisma.Decimal) => rows.reduce((t, r) => t.add(f(r)), Z);
  const grossGood = sum((r) => r.goodQty);
  const scrap = sum((r) => r.scrapQty);
  const rework = sum((r) => r.reworkQty);
  const reclass = sum((r) => r.reclassifiedFromGoodQty);
  const effectiveGood = grossGood.sub(reclass);
  const reworkOpen = rework.sub(sum((r) => r.reworkGoodQty)).sub(sum((r) => r.reworkScrapQty));
  const processed = grossGood.add(scrap).add(rework);
  return {
    grossGood: grossGood.toString(),
    effectiveGood: effectiveGood.toString(),
    scrap: scrap.toString(),
    rework: rework.toString(),
    reworkOpen: reworkOpen.toString(),
    reclassified: reclass.toString(),
    processed: processed.toString(),
    yieldPercent: processed.isZero() ? null : effectiveGood.div(processed).mul(100).toDecimalPlaces(1).toString(),
  };
}

/**
 * Job-level totals. With stages, the same physical units pass through every stage,
 * so good output is NOT the sum of each stage's good: it is what left the LAST
 * stage. Scrap and rework are losses wherever they happen, so those do sum.
 * Yield is only stated once the whole routing is complete (mid-line units are
 * neither good nor lost yet, so a live ratio would be misleading).
 * A job without stages is simply totalsOf(rows).
 */
export function jobTotals(stages: { id: string; sequence: number; status: string }[], rows: OutputRow[]): OutputTotals {
  const all = totalsOf(rows);
  if (stages.length === 0) return all;
  const last = [...stages].sort((a, b) => b.sequence - a.sequence)[0]!;
  const lastT = totalsOf(rows.filter((r) => r.jobStageId === last.id));
  const effGood = D(lastT.effectiveGood);
  const processed = effGood.add(D(all.scrap)).add(D(all.reworkOpen));
  const complete = stages.every((s) => s.status === "completed");
  return {
    ...all,
    grossGood: lastT.grossGood,
    effectiveGood: lastT.effectiveGood,
    processed: processed.toString(),
    yieldPercent: complete && processed.gt(0) ? effGood.div(processed).mul(100).toDecimalPlaces(1).toString() : null,
  };
}

export function totalsByStage(rows: OutputRow[]): Map<string | null, OutputTotals> {
  const keys = new Set(rows.map((r) => r.jobStageId));
  return new Map([...keys].map((k) => [k, totalsOf(rows.filter((r) => r.jobStageId === k))]));
}

/**
 * Invariants that must hold over the NON-VOIDED entries after any write or void.
 * Returns human-readable violations (empty = consistent).
 */
export function checkInvariants(
  rows: OutputRow[],
  inspections: InspectionRow[],
  /** Routing order. When given, a stage can't account for more units than left the stage before it. */
  stageOrder: { id: string; sequence: number; name: string }[] = [],
): string[] {
  const out: string[] = [];
  const ordered = [...stageOrder].sort((a, b) => a.sequence - b.sequence);
  for (let i = 1; i < ordered.length; i++) {
    const prev = totalsOf(rows.filter((r) => r.jobStageId === ordered[i - 1]!.id));
    const cur = totalsOf(rows.filter((r) => r.jobStageId === ordered[i]!.id));
    // every unit at this stage is good, scrapped or still in rework -- exactly once
    const accounted = D(cur.effectiveGood).add(D(cur.scrap)).add(D(cur.reworkOpen));
    if (accounted.gt(D(prev.effectiveGood))) {
      out.push(`Stage "${ordered[i]!.name}" would account for ${accounted.toString()} unit(s), but only ${prev.effectiveGood} left "${ordered[i - 1]!.name}".`);
    }
  }
  const stages = new Set<string | null>([...rows.map((r) => r.jobStageId), ...inspections.map((i) => i.jobStageId)]);
  for (const st of stages) {
    const rs = rows.filter((r) => r.jobStageId === st);
    const t = totalsOf(rs);
    const where = st ? "for this stage" : "for this job";
    if (D(t.reworkOpen).isNegative()) out.push(`More units were resolved from rework than were ever sent to rework ${where}.`);
    if (D(t.effectiveGood).isNegative()) out.push(`More units were reclassified than were ever counted good ${where}.`);
    const inspected = inspections.filter((i) => i.jobStageId === st).reduce((a, i) => a.add(i.producedQty), Z);
    if (inspected.gt(D(t.grossGood))) out.push(`More units were inspected than were reported good ${where}.`);
  }
  return out;
}

export interface StageState {
  id: string;
  sequence: number;
  name: string;
  status: "pending" | "in_progress" | "completed";
  blocked: boolean;
  requiresInspection: boolean;
}

/** Why a single stage cannot be completed yet (empty = it can). */
export function stageCompletionBlockers(
  stage: StageState,
  rows: OutputRow[],
  inspections: InspectionRow[],
): string[] {
  const b: string[] = [];
  if (stage.status !== "in_progress") b.push(`Stage "${stage.name}" is not in progress.`);
  if (stage.blocked) b.push(`Stage "${stage.name}" is blocked; unblock it first.`);
  const mine = rows.filter((r) => r.jobStageId === stage.id);
  const t = totalsOf(mine);
  if (D(t.processed).isZero()) b.push(`No output has been recorded for "${stage.name}".`);
  if (D(t.reworkOpen).gt(0)) b.push(`${t.reworkOpen} unit(s) are still in rework at "${stage.name}".`);
  const ins = inspections.filter((i) => i.jobStageId === stage.id);
  const open = ins.reduce((a, i) => a.add(i.rejectedQty.sub(i.dispositionedQty)), Z);
  if (open.gt(0)) b.push(`${open.toString()} rejected unit(s) at "${stage.name}" still need a disposition.`);
  if (stage.requiresInspection) {
    const inspected = ins.reduce((a, i) => a.add(i.producedQty), Z);
    const uninspected = D(t.grossGood).sub(inspected);
    if (inspected.isZero()) b.push(`"${stage.name}" requires an inspection and none has been recorded.`);
    else if (uninspected.gt(0)) b.push(`${uninspected.toString()} good unit(s) at "${stage.name}" have not been inspected.`);
  }
  return b;
}

/** Why the JOB cannot be completed from the shop-floor's point of view. */
export function jobCompletionBlockers(stages: StageState[], rows: OutputRow[], inspections: InspectionRow[]): string[] {
  const b: string[] = [];
  for (const s of [...stages].sort((x, y) => x.sequence - y.sequence)) {
    if (s.status !== "completed") b.push(`Stage ${s.sequence} "${s.name}" is not completed.`);
  }
  const t = totalsOf(rows);
  if (D(t.reworkOpen).gt(0)) b.push(`${t.reworkOpen} unit(s) are still in rework.`);
  const open = inspections.reduce((a, i) => a.add(i.rejectedQty.sub(i.dispositionedQty)), Z);
  if (open.gt(0)) b.push(`${open.toString()} rejected unit(s) still need a disposition.`);
  return b;
}

/** Sequential routing: a stage may start only when every earlier stage is completed. */
export function startBlockers(stage: StageState, all: StageState[]): string[] {
  const b: string[] = [];
  if (stage.status !== "pending") b.push(`Stage "${stage.name}" has already ${stage.status === "completed" ? "been completed" : "started"}.`);
  const earlier = all.filter((s) => s.sequence < stage.sequence && s.status !== "completed");
  for (const e of earlier) b.push(`Stage ${e.sequence} "${e.name}" must be completed first.`);
  return b;
}
