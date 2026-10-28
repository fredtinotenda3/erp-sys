import Link from "next/link";

import { Card } from "../../../components/ui/card";
import { PageHeader } from "../../../components/ui/page-header";
import { AccessDenied } from "../../../components/ui/states";
import { getPageContext } from "../../../lib/server/page-context";

export const metadata = { title: "Reports · Operis" };

export default async function ReportsPage() {
  const ctx = await getPageContext();
  if (!ctx.can("cost:read") || !ctx.can("production_job:read")) return <AccessDenied what="management reports" />;
  return (
    <>
      <PageHeader title="Reports" description="Every figure comes from the same cost services that power job pages; nothing here is recalculated in the browser." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/reports/job-costs" className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
          <Card className="h-full p-4 hover:bg-muted/40"><h2 className="font-semibold">Job costs</h2><p className="mt-1 text-sm text-muted-foreground">Estimated versus actual material and labour cost for every job, in each job&apos;s own currency.</p></Card>
        </Link>
        <Link href="/reports/profitability" className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
          <Card className="h-full p-4 hover:bg-muted/40"><h2 className="font-semibold">Profitability</h2><p className="mt-1 text-sm text-muted-foreground">Gross profit on completed jobs, measured against each job&apos;s quote. Excludes overhead.</p></Card>
        </Link>
      </div>
    </>
  );
}
