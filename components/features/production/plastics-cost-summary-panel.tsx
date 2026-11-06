import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Money, Provenance, Quantity, Unavailable } from "@/components/ui/provenance";
import type { PlasticsJobCostSummary } from "@/lib/api-types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * Read-only. materialCost/labourCost/costPerGoodUnit come straight from the
 * same job-costing engine the Costs tab uses (cost-service.ts's getJobCost)
 * -- this panel adds only the two genuinely new figures, regrind generated
 * and consumed. machineCost is always "Unavailable" here: this system has
 * no connected machine telemetry or energy metering, and the mandate is
 * explicit that this must never be invented.
 */
export function PlasticsCostSummaryPanel({ summary }: { summary: PlasticsJobCostSummary }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Plastics production analytics</CardTitle>
        <Provenance kind="calculated" />
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2.5 text-sm">
          <Row label="Material cost">
            {summary.materialCost ? <Money amount={summary.materialCost.amount} currency={summary.materialCost.currency} /> : <Unavailable reason="mixed currencies or no actual cost recorded" />}
          </Row>
          <Row label="Labour cost">
            {summary.labourCost ? <Money amount={summary.labourCost.amount} currency={summary.labourCost.currency} /> : <Unavailable reason="no labour recorded, or mixed currencies" />}
          </Row>
          <Row label="Machine cost">
            <Unavailable reason={summary.machineCost.note} />
          </Row>
          <Row label="Good output">
            <Quantity value={summary.goodOutputQty} />
          </Row>
          <Row label="Scrap">
            <Quantity value={summary.scrapQty} />
            {summary.scrapRatePct !== null ? <span className="text-muted-foreground"> ({summary.scrapRatePct}% of processed)</span> : null}
          </Row>
          <Row label="Yield">
            {summary.yieldPct !== null ? `${summary.yieldPct}%` : <span className="text-muted-foreground">Not yet available (routing not complete)</span>}
          </Row>
          <Row label="Regrind generated from this job">
            <Quantity value={summary.regrindGeneratedQty} />
          </Row>
          <Row label="Regrind consumed on this job">
            <Quantity value={summary.regrindConsumedQty} />
          </Row>
          <Row label="Cost per good unit">
            {summary.costPerGoodUnit ? <Money amount={summary.costPerGoodUnit.amount} currency={summary.costPerGoodUnit.currency} /> : <Unavailable reason="not available yet" />}
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}
