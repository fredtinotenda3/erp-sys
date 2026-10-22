// "May this job be completed from the shop floor's point of view?"
// One answer, used both to show blockers in the UI and to refuse completion on
// the server (inside the completion transaction, under the job's exclusive lock).
// A job that has no stages, no output and no inspections is always ready: the
// shop-floor module is opt-in per job and changes nothing for jobs that don't use it.
import { ConflictError } from "../../shared/errors";
import { loadShopfloor, type Db } from "./shopfloor-data";
import { jobCompletionBlockers, stageCompletionBlockers } from "./shopfloor-math";
import { prisma } from "../../shared/db";

export async function computeReadiness(db: Db | typeof prisma, orgId: string, jobId: string) {
  const s = await loadShopfloor(db, orgId, jobId);
  const jobBlockers = jobCompletionBlockers(s.stages, s.outputs, s.inspections);
  return {
    usesStages: s.stages.length > 0,
    canComplete: jobBlockers.length === 0,
    jobBlockers,
    stages: s.stages.map((st) => ({
      id: st.id,
      sequence: st.sequence,
      name: st.name,
      // what would stop THIS stage being completed right now (for in-progress stages)
      completionBlockers: st.status === "completed" ? [] : stageCompletionBlockers({ ...st, status: "in_progress" }, s.outputs, s.inspections),
    })),
  };
}

export async function assertReadyToComplete(tx: Db, orgId: string, jobId: string): Promise<void> {
  const r = await computeReadiness(tx, orgId, jobId);
  if (!r.canComplete) {
    throw new ConflictError(`This job cannot be completed yet: ${r.jobBlockers.join(" ")}`);
  }
}
