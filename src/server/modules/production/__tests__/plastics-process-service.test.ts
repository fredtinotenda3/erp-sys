// Milestone 6 (Plastics Manufacturing Vertical): plastics process detail --
// the process-type/mould/cycle-time/cavity record for one production job
// stage. Real-database test, not executed in this environment -- see
// IMPLEMENTATION_MANIFEST.md and industry-profile-service.test.ts's header
// comment for why. Run with `npm test -- plastics-process-service`.
//
// Covers:
//  - getPlasticsProcessDetail/setPlasticsProcessDetail: processType required
//    on create, optional thereafter (partial-merge, not full-replace --
//    same discipline as plastics-item-service.ts)
//  - mouldId must reference a real mould in this organization
//  - goodCavities <= totalCavities, INCLUDING the explicit-null-clear fix
//    made during this round's hand-verification: an explicit
//    totalCavities: null must be honored by the check (nothing to validate
//    goodCavities against), not silently replaced by the stale existing
//    totalCavities -- the exact defect found while reviewing this file's
//    pre-validation computation and fixed before this delivery
//  - the stage-completion lock: once stage.status === "completed", process
//    detail can no longer be changed (ConflictError), for both an update
//    and a first-time create
//  - plastics_process:record capability and the plastics-profile write
//    gate, with reads (production_job:read) never profile-gated
//  - org and branch tenant isolation
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { sessionWithRole, productWithActiveBom } from "./production-helpers";
import { createJob } from "../job-service";
import { defineStages, transitionStage } from "../stage-service";
import { recordOutput } from "../output-service";
import { createMould } from "../mould-service";
import { updateIndustryProfile } from "../../industry/industry-profile-service";
import { getPlasticsProcessDetail, setPlasticsProcessDetail } from "../plastics-process-service";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

let org: TestOrg;
let owner: AuthenticatedSession;
let operator: AuthenticatedSession; // plastics_process:record
let inv: AuthenticatedSession; // lacks plastics_process:record
let viewer: AuthenticatedSession;
let branchId: string;
let mouldId: string;

async function newJobWithStage() {
  const { product } = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }]);
  // job-service.ts's createJob/getJob return an untyped Record<string,
  // unknown> view (see job-view.ts's toJobView) -- same `as any` idiom
  // every other test file in this project uses at this exact call site
  // (capacity-service.test.ts, corrective-action-service.test.ts,
  // milestone4-extensions.test.ts, etc).
  const job = (await createJob(owner, { branchId, productItemId: product.id, plannedQty: 10 })) as any;
  // defineStages requires the job still "planned"/"released" -- done here,
  // before anything else touches the job, same as stage-service.ts's own
  // "routing can only be defined before the job has started" rule.
  const defined = await defineStages(owner, job.id as string, { stages: [{ name: "Moulding" }] });
  return { jobId: job.id as string, stageId: defined.stages[0].id };
}

/** Drives a stage from pending -> in_progress -> completed with the minimum
 * needed to satisfy stageCompletionBlockers (no inspection required, one
 * output entry recorded). Uses `owner` throughout -- this is setup for the
 * test under scrutiny, not the thing being tested. */
async function completeStage(jobId: string, stageId: string) {
  await transitionStage(owner, jobId, stageId, { action: "start" });
  await recordOutput(owner, jobId, { clientRequestId: randomUUID(), jobStageId: stageId, goodQty: 5 });
  await transitionStage(owner, jobId, stageId, { action: "complete" });
}

beforeAll(async () => {
  org = await createTestOrg("ppA");
  owner = await ownerSession(org);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "pp-op", [org.branchId]);
  inv = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "pp-inv", [org.branchId]);
  viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "pp-vw", [org.branchId]);
  await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
  branchId = org.branchId;
  mouldId = (await createMould(owner, { branchId, code: "M-1", name: "Bottle mould", cavityCount: 4 })).id;
}, 180_000);

describe("getPlasticsProcessDetail", () => {
  it("returns null before anything is recorded, readable by every role", async () => {
    const { stageId } = await newJobWithStage();
    for (const session of [owner, operator, inv, viewer]) {
      await expect(getPlasticsProcessDetail(session, stageId)).resolves.toBeNull();
    }
  });

  it("404s for a stage that does not belong to this organization", async () => {
    await expect(getPlasticsProcessDetail(owner, randomUUID())).rejects.toThrow(NotFoundError);
  });
});

describe("setPlasticsProcessDetail", () => {
  it("requires processType when creating process detail for the first time", async () => {
    const { stageId } = await newJobWithStage();
    await expect(setPlasticsProcessDetail(operator, stageId, { targetCycleTimeSeconds: 12 })).rejects.toThrow(ValidationError);
  });

  it("creates and reads back process detail", async () => {
    const { stageId } = await newJobWithStage();
    const row: any = await setPlasticsProcessDetail(operator, stageId, {
      processType: "injection_moulding",
      mouldId,
      targetCycleTimeSeconds: 18,
      totalCavities: 4,
      goodCavities: 4,
    });
    expect(row.processType).toBe("injection_moulding");
    expect(row.mouldId).toBe(mouldId);
    expect(row.targetCycleTimeSeconds.toString()).toBe("18");
    expect(row.totalCavities).toBe(4);

    const read: any = await getPlasticsProcessDetail(owner, stageId);
    expect(read.processType).toBe("injection_moulding");
    expect(read.goodCavities).toBe(4);
  });

  it("does not require processType again on a later partial update, and preserves omitted fields (partial-merge, not full-replace)", async () => {
    const { stageId } = await newJobWithStage();
    await setPlasticsProcessDetail(operator, stageId, {
      processType: "blow_moulding",
      mouldId,
      targetCycleTimeSeconds: 20,
      totalCavities: 4,
      goodCavities: 4,
    });
    const row: any = await setPlasticsProcessDetail(operator, stageId, { actualCycleTimeSeconds: 21.5 });
    expect(row.processType).toBe("blow_moulding"); // preserved
    expect(row.mouldId).toBe(mouldId); // preserved
    expect(row.targetCycleTimeSeconds.toString()).toBe("20"); // preserved
    expect(row.totalCavities).toBe(4); // preserved
    expect(row.actualCycleTimeSeconds.toString()).toBe("21.5"); // updated
  });

  it("an explicit null clears a field, distinct from omitting it", async () => {
    const { stageId } = await newJobWithStage();
    await setPlasticsProcessDetail(operator, stageId, { processType: "injection_moulding", mouldId });
    const row: any = await setPlasticsProcessDetail(operator, stageId, { mouldId: null });
    expect(row.mouldId).toBeNull();
    expect(row.processType).toBe("injection_moulding"); // other fields still untouched
  });

  it("rejects a mouldId that is not a mould in this organization", async () => {
    const { stageId } = await newJobWithStage();
    await expect(
      setPlasticsProcessDetail(operator, stageId, { processType: "injection_moulding", mouldId: randomUUID() }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects goodCavities greater than totalCavities", async () => {
    const { stageId } = await newJobWithStage();
    await expect(
      setPlasticsProcessDetail(operator, stageId, { processType: "injection_moulding", totalCavities: 4, goodCavities: 5 }),
    ).rejects.toThrow(ValidationError);
  });

  it("an explicit null clearing totalCavities is honored by the goodCavities check, not silently replaced by the stale existing value", async () => {
    // This is exactly the edge case the `!== undefined` fix addresses: with
    // the old `??`-based computation, `totalCavities: null` would have
    // fallen back to the EXISTING totalCavities (4) for this check while
    // the write itself correctly nulled it -- incorrectly rejecting a
    // legitimate request that clears the total while raising goodCavities
    // past the old total, which is no longer a meaningful comparison once
    // totalCavities is unknown.
    const { stageId } = await newJobWithStage();
    await setPlasticsProcessDetail(operator, stageId, { processType: "injection_moulding", totalCavities: 4, goodCavities: 2 });
    const row: any = await setPlasticsProcessDetail(operator, stageId, { totalCavities: null, goodCavities: 10 });
    expect(row.totalCavities).toBeNull();
    expect(row.goodCavities).toBe(10);
  });
});

describe("stage-completion lock", () => {
  it("rejects any change once the stage has been completed", async () => {
    const { jobId, stageId } = await newJobWithStage();
    await setPlasticsProcessDetail(operator, stageId, { processType: "injection_moulding", mouldId, totalCavities: 4, goodCavities: 4 });
    await completeStage(jobId, stageId);
    await expect(setPlasticsProcessDetail(operator, stageId, { actualCycleTimeSeconds: 19 })).rejects.toThrow(ConflictError);
  });

  it("also rejects creating process detail for the first time on an already-completed stage", async () => {
    const { jobId, stageId } = await newJobWithStage();
    await completeStage(jobId, stageId);
    // The completed-stage check runs before the "processType required on
    // create" check, so this is a ConflictError, not a ValidationError.
    await expect(setPlasticsProcessDetail(operator, stageId, { processType: "injection_moulding" })).rejects.toThrow(ConflictError);
  });

  it("reads remain available once the stage is completed", async () => {
    const { jobId, stageId } = await newJobWithStage();
    await setPlasticsProcessDetail(operator, stageId, { processType: "injection_moulding" });
    await completeStage(jobId, stageId);
    const read: any = await getPlasticsProcessDetail(owner, stageId);
    expect(read.processType).toBe("injection_moulding");
  });
});

describe("capability and plastics-profile gates", () => {
  it("requires plastics_process:record to write, but not to read", async () => {
    const { stageId } = await newJobWithStage();
    await expect(setPlasticsProcessDetail(inv, stageId, { processType: "injection_moulding" })).rejects.toThrow(ForbiddenError);
    await expect(setPlasticsProcessDetail(viewer, stageId, { processType: "injection_moulding" })).rejects.toThrow(ForbiddenError);
    await expect(getPlasticsProcessDetail(inv, stageId)).resolves.toBeNull();
  });

  it("requires the plastics profile to be active to write, but reads remain available after switching away", async () => {
    const { stageId } = await newJobWithStage();
    await setPlasticsProcessDetail(operator, stageId, { processType: "injection_moulding" });
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
    await expect(setPlasticsProcessDetail(operator, stageId, { actualCycleTimeSeconds: 5 })).rejects.toThrow(ValidationError);
    // Historical data stays fully visible -- reads are never profile-gated.
    const stillReadable: any = await getPlasticsProcessDetail(owner, stageId);
    expect(stillReadable.processType).toBe("injection_moulding");
    await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
  });
});

describe("tenant isolation", () => {
  it("a stage from a different organization never resolves", async () => {
    const orgB = await createTestOrg("ppB");
    const ownerB = await ownerSession(orgB);
    // Switched to plastics first so this request fails on the tenant-
    // isolation check this test actually targets, not on the (separately
    // tested, above) profile gate.
    await updateIndustryProfile(ownerB, { industryProfile: "plastics", enabledModules: [] });
    const { stageId } = await newJobWithStage();
    await expect(getPlasticsProcessDetail(ownerB, stageId)).rejects.toThrow(NotFoundError);
    await expect(setPlasticsProcessDetail(ownerB, stageId, { processType: "x" })).rejects.toThrow(NotFoundError);
  });

  it("a stage outside the session's branch access never resolves", async () => {
    const branch2 = await createBranch(owner, { name: "PP branch 2" });
    const { product } = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 1, standardCostCurrency: "USD", bomQty: 1 }]);
    const job2 = (await createJob(owner, { branchId: branch2.id, productItemId: product.id, plannedQty: 5 })) as any;
    const defined2 = await defineStages(owner, job2.id as string, { stages: [{ name: "Moulding" }] });
    // `operator`'s session is scoped only to the main branch (see beforeAll).
    await expect(getPlasticsProcessDetail(operator, defined2.stages[0].id)).rejects.toThrow(NotFoundError);
  });
});
