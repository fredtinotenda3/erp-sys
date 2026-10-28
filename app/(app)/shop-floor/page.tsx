import Link from "next/link";
import { CircleAlert, UserCheck } from "lucide-react";

import { listWorkspaceJobs, type WorkspaceJob } from "../../../src/server/modules/production/shopfloor-workspace";
import { Badge } from "../../../components/ui/badge";
import { Card } from "../../../components/ui/card";
import { PageHeader } from "../../../components/ui/page-header";
import { Quantity } from "../../../components/ui/provenance";
import { AccessDenied, EmptyState, LoadFailure } from "../../../components/ui/states";
import { JobStatusBadge } from "../../../components/ui/status-badge";
import { formatDate } from "../../../lib/format";
import { getPageContext, load } from "../../../lib/server/page-context";

export const metadata = { title: "Shop floor · Operis" };

export default async function ShopFloorPage() {
  const ctx = await getPageContext();
  if (!ctx.can("production_job:read")) return <AccessDenied what="the shop floor" />;
  const res = await load<WorkspaceJob[]>(() => listWorkspaceJobs(ctx.session, { branchId: ctx.selectedBranchId ?? undefined }));
  const multi = ctx.me.branches.length > 1;

  return (
    <>
      <PageHeader title="Jobs on the floor" description="Open a job to start stages, record output and labour, and inspect. Jobs with a stage assigned to you are first." />
      {!res.ok ? <LoadFailure status={res.status} message={res.message} what="shop-floor jobs" /> : res.data.length === 0 ? (
        <EmptyState title="No jobs are open for work right now">A job appears here once a manager releases it.</EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {res.data.map((j) => (
            <li key={j.id}>
              <Link href={`/shop-floor/jobs/${j.id}`} className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Card className="min-h-36 space-y-2 p-4 hover:bg-muted/40">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-lg font-semibold">{j.jobNumber}</span>
                    <span className="flex items-center gap-2">
                      {j.assignedToMe ? <Badge variant="status-info"><UserCheck aria-hidden="true" />Assigned to you</Badge> : null}
                      <JobStatusBadge status={j.status} />
                    </span>
                  </div>
                  <p className="text-sm">{j.product} · <Quantity value={j.plannedQty} uom={j.uom} /></p>
                  <p className="text-sm text-muted-foreground">
                    {j.stagesTotal === 0 ? "No stages defined — record output for the whole job" : `Stage ${Math.min(j.stagesDone + 1, j.stagesTotal)} of ${j.stagesTotal}${j.currentStage ? `: ${j.currentStage}` : ""}`}
                    {j.plannedEnd ? ` · due ${formatDate(j.plannedEnd)}` : ""}
                    {multi ? ` · ${ctx.branchName(j.branchId)}` : ""}
                  </p>
                  {j.blockedStage ? <p className="flex items-center gap-1 text-sm text-status-danger"><CircleAlert className="size-4" aria-hidden="true" /> {j.blockedStage} is blocked</p> : null}
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
