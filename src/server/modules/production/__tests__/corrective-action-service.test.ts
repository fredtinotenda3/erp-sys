// Milestone 4: corrective actions -- the tracked root-cause follow-up on a
// quality problem, distinct from QualityDisposition (which only decides
// what happens to the rejected units). See corrective-action-service.ts's
// file header.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createJob, transitionJob } from "../job-service";
import { recordOutput } from "../output-service";
import { recordInspection } from "../quality-service";
import { createCorrectiveAction, listCorrectiveActions, updateCorrectiveAction } from "../corrective-action-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { productWithActiveBom, sessionWithRole } from "./production-helpers";

let org: TestOrg;
let owner: AuthenticatedSession;
let mgr: AuthenticatedSession; // corrective_action:manage
let operator: AuthenticatedSession; // quality:read only (no corrective_action:manage)
let productId: string;

beforeAll(async () => {
  org = await createTestOrg("caA");
  owner = await ownerSession(org);
  mgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "ca-mgr", [org.branchId]);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "ca-op", [org.branchId]);
  productId = (await productWithActiveBom(owner, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }])).product.id;
}, 180_000);

async function releasedJob(): Promise<string> {
  const job = (await createJob(owner, { branchId: org.branchId, productItemId: productId, plannedQty: 1 })) as any;
  await transitionJob(owner, job.id, { status: "released" });
  return job.id as string;
}

async function failedInspection(jobId: string): Promise<string> {
  await recordOutput(mgr, jobId, { clientRequestId: randomUUID(), goodQty: 10 });
  const insp = await recordInspection(mgr, jobId, { clientRequestId: randomUUID(), inspectedQty: 10, rejectedQty: 2, rejectReason: "wrong_dimensions" });
  return insp.inspection.id;
}

describe("createCorrectiveAction", () => {
  it("creates a corrective action against a job and audits it", async () => {
    const jobId = await releasedJob();
    const ca: any = await createCorrectiveAction(mgr, jobId, { description: "Recalibrate extruder" });
    expect(ca.status).toBe("open");
    expect(ca.jobId).toBe(jobId);
    expect(ca.resolvedAt).toBeNull();
  });

  it("can optionally be tied to a specific quality record on the same job", async () => {
    const jobId = await releasedJob();
    const qrId = await failedInspection(jobId);
    const ca: any = await createCorrectiveAction(mgr, jobId, { description: "Investigate root cause", qualityRecordId: qrId });
    expect(ca.qualityRecordId).toBe(qrId);
  });

  it("rejects a quality record that belongs to a different job", async () => {
    const jobId = await releasedJob();
    const otherJob = await releasedJob();
    const qrId = await failedInspection(otherJob);
    await expect(createCorrectiveAction(mgr, jobId, { description: "Wrong job's record", qualityRecordId: qrId })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an inactive or unknown assignedToUserId", async () => {
    const jobId = await releasedJob();
    await expect(createCorrectiveAction(mgr, jobId, { description: "Assign to nobody", assignedToUserId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("requires a description of at least 5 characters", async () => {
    const jobId = await releasedJob();
    await expect(createCorrectiveAction(mgr, jobId, { description: "x" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("only corrective_action:manage may create one", async () => {
    const jobId = await releasedJob();
    await expect(createCorrectiveAction(operator, jobId, { description: "Not allowed" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("branch and tenant isolation: not found for a job outside scope", async () => {
    const jobId = await releasedJob();
    const orgB = await createTestOrg("caB");
    const ownerB = await ownerSession(orgB);
    await expect(createCorrectiveAction(ownerB, jobId, { description: "Cross tenant" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listCorrectiveActions", () => {
  it("lists actions for a job, open ones first", async () => {
    const jobId = await releasedJob();
    const a: any = await createCorrectiveAction(mgr, jobId, { description: "First action" });
    const b: any = await createCorrectiveAction(mgr, jobId, { description: "Second action" });
    await updateCorrectiveAction(mgr, jobId, a.id, { status: "completed", resolutionNotes: "Fixed it" });
    const list: any[] = await listCorrectiveActions(mgr, jobId);
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
  });
});

describe("updateCorrectiveAction", () => {
  it("moves through in_progress to completed, requiring resolutionNotes to close", async () => {
    const jobId = await releasedJob();
    const ca: any = await createCorrectiveAction(mgr, jobId, { description: "Needs work" });
    await expect(updateCorrectiveAction(mgr, jobId, ca.id, { status: "completed" })).rejects.toBeInstanceOf(ValidationError);
    const inProgress: any = await updateCorrectiveAction(mgr, jobId, ca.id, { status: "in_progress" });
    expect(inProgress.status).toBe("in_progress");
    const done: any = await updateCorrectiveAction(mgr, jobId, ca.id, { status: "completed", resolutionNotes: "Recalibrated and verified" });
    expect(done.status).toBe("completed");
    expect(done.resolvedAt).toBeTruthy();
  });

  it("cancelling also requires resolutionNotes and stamps resolvedAt", async () => {
    const jobId = await releasedJob();
    const ca: any = await createCorrectiveAction(mgr, jobId, { description: "Will cancel" });
    const cancelled: any = await updateCorrectiveAction(mgr, jobId, ca.id, { status: "cancelled", resolutionNotes: "No longer needed" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.resolvedAt).toBeTruthy();
  });

  it("a completed or cancelled action can no longer be changed", async () => {
    const jobId = await releasedJob();
    const ca: any = await createCorrectiveAction(mgr, jobId, { description: "Will close" });
    await updateCorrectiveAction(mgr, jobId, ca.id, { status: "completed", resolutionNotes: "Done" });
    await expect(updateCorrectiveAction(mgr, jobId, ca.id, { status: "in_progress" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejects an empty update payload", async () => {
    const jobId = await releasedJob();
    const ca: any = await createCorrectiveAction(mgr, jobId, { description: "Needs work" });
    await expect(updateCorrectiveAction(mgr, jobId, ca.id, {})).rejects.toBeInstanceOf(ValidationError);
  });

  it("only corrective_action:manage may update one", async () => {
    const jobId = await releasedJob();
    const ca: any = await createCorrectiveAction(mgr, jobId, { description: "Needs work" });
    await expect(updateCorrectiveAction(operator, jobId, ca.id, { status: "in_progress" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
