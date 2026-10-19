import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { LocalTime } from "@/components/ui/local-time";
import { Notice } from "@/components/ui/notice";
import { Money, Provenance, Quantity, Unavailable } from "@/components/ui/provenance";
import { Select } from "@/components/ui/select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { COMPONENT_LABEL, EXPLANATION_REASON, PROFIT_REASON, RATE_BASIS_LABEL, VARIANCE_REASON } from "@/lib/cost-copy";
import { formatDate, formatDateTimeUtc } from "@/lib/format";
import type { Currency, JobCost } from "@/lib/api-types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

const signed = (v: string) => (v.startsWith("-") || v === "0" ? v : `+${v}`);

// Presentation only. Every figure, every "may we state this?" decision and every
// reason comes from the server (cost-service). Nothing is calculated here.
export function CostsView({
  cost: c,
  itemLabel,
  actorName,
  adjustAction,
  convert,
}: {
  cost: JobCost;
  itemLabel: (id: string) => string;
  actorName: (id: string | null) => string;
  /** The "Record adjustment" control, present only for roles that may adjust a frozen job. */
  adjustAction: React.ReactNode;
  convert: { currencies: Currency[]; convertTo?: string; rateSource?: string; asOf?: string } | null;
}) {
  const final = c.snapshot.status === "frozen";
  const ev = c.snapshot.evidence;
  const at = c.snapshot.completenessAtCompletion as { missing?: { code: string; message: string; component: string }[]; legacy?: boolean } | null;

  return (
    <div className="space-y-4">
      {/* Snapshot status */}
      {final ? (
        <Notice tone="success" title="Final cost — frozen at completion">
          Frozen {c.snapshottedAt ? formatDateTimeUtc(c.snapshottedAt) : ""}. It cannot be edited or reopened; corrections appear below as adjustments.
          {ev && typeof ev.costedMovements === "number" ? (
            <span className="block text-xs text-muted-foreground">
              Evidence counted: {String(ev.costedMovements)} material movement{ev.costedMovements === 1 ? "" : "s"}
              {typeof ev.uncostedMovements === "number" && ev.uncostedMovements > 0 ? ` (+${String(ev.uncostedMovements)} without a cost)` : ""}, {String(ev.labourRecords ?? 0)} labour record
              {ev.labourRecords === 1 ? "" : "s"} ({String(ev.labourHours ?? 0)} h).
            </span>
          ) : at?.legacy ? (
            <span className="block text-xs text-muted-foreground">Frozen before completeness evidence was recorded.</span>
          ) : null}
        </Notice>
      ) : (
        <Notice tone="info" title="Live cost — not frozen">
          Actual figures are calculated from material issued and labour recorded so far and keep changing until the job is completed. Variance and margin are withheld until then.
        </Notice>
      )}

      {/* Completeness */}
      <Card>
        <CardHeader>
          <CardTitle>Cost completeness</CardTitle>
          <span className="text-xs text-muted-foreground">What is and isn&apos;t in these figures</span>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {c.completeness.missing.map((m) => (
              <li key={m.code} className="flex items-start gap-2">
                <Provenance kind={m.component === "overhead" ? "unavailable" : "estimated"} label={COMPONENT_LABEL[m.component] ?? m.component} />
                <span>{m.message}</span>
              </li>
            ))}
            {c.completeness.missing.filter((m) => m.component !== "overhead").length === 0 ? (
              <li className="text-muted-foreground">Estimate, material and labour are all recorded. Overhead is the only component not available.</li>
            ) : null}
          </ul>
        </CardContent>
      </Card>

      {c.unpricedMaterials.length > 0 ? (
        <Notice tone="warning" title="Some materials are unpriced">
          Unpriced: {c.unpricedMaterials.map((u) => `${itemLabel(u.materialItemId)} (${u.reason === "uom_mismatch" ? "unit differs from stock unit" : "no standard cost"})`).join("; ")}.
        </Notice>
      ) : null}

      {/* Per-currency table */}
      {c.lines.length === 0 ? (
        <Notice tone="neutral">No cost has been recorded yet and there is no priced estimate. Nothing is shown as zero.</Notice>
      ) : (
        c.lines.map((l) => (
          <Card key={l.currency}>
            <CardHeader>
              <CardTitle>{l.currency} costs</CardTitle>
              <span className="text-xs text-muted-foreground">Each currency is shown separately</span>
            </CardHeader>
            <Table>
              <THead>
                <tr>
                  <TH>Cost</TH>
                  <TH className="text-right">Estimated</TH>
                  <TH className="text-right">
                    {final ? "Actual" : "Actual to date"} <Provenance kind={final ? "actual" : "calculated"} />
                  </TH>
                  <TH className="text-right">Adjustments</TH>
                  <TH className="text-right">Adjusted actual</TH>
                  <TH className="text-right">Variance</TH>
                </tr>
              </THead>
              <TBody>
                <TR>
                  <TD>Material</TD>
                  <TD className="text-right"><Money amount={l.estimated.material} currency={l.currency} unavailableReason="unpriced" /></TD>
                  <TD className="text-right"><Money amount={l.actual.material} currency={l.currency} /></TD>
                  <TD className="text-right">{l.adjustments.material ? <Money amount={l.adjustments.material} currency={l.currency} /> : <span className="text-muted-foreground">—</span>}</TD>
                  <TD className="text-right font-medium"><Money amount={l.adjusted.material} currency={l.currency} /></TD>
                  <TD className="text-right">
                    {l.variance.comparable && l.variance.amount !== null ? (
                      <span>
                        <Money amount={l.variance.amount} currency={l.currency} />
                        {l.variance.percent ? <span className="block text-xs text-muted-foreground">{signed(l.variance.percent)}% vs estimate</span> : null}
                      </span>
                    ) : (
                      <Unavailable reason={VARIANCE_REASON[l.variance.reason ?? ""] ?? l.variance.reason ?? undefined} />
                    )}
                  </TD>
                </TR>
                <TR>
                  <TD>Labour</TD>
                  <TD className="text-right"><Unavailable reason="no estimate method" /></TD>
                  <TD className="text-right"><Money amount={l.actual.labour} currency={l.currency} unavailableReason="none recorded" /></TD>
                  <TD className="text-right">{l.adjustments.labour ? <Money amount={l.adjustments.labour} currency={l.currency} /> : <span className="text-muted-foreground">—</span>}</TD>
                  <TD className="text-right font-medium"><Money amount={l.adjusted.labour} currency={l.currency} unavailableReason="none recorded" /></TD>
                  <TD className="text-right"><Unavailable /></TD>
                </TR>
                <TR>
                  <TD>Overhead</TD>
                  <TD className="text-right"><Unavailable /></TD>
                  <TD className="text-right"><Unavailable /></TD>
                  <TD className="text-right"><span className="text-muted-foreground">—</span></TD>
                  <TD className="text-right"><Unavailable /></TD>
                  <TD className="text-right"><Unavailable /></TD>
                </TR>
              </TBody>
            </Table>
          </Card>
        ))
      )}
      <p className="text-xs text-muted-foreground">Overhead: {c.overheadReason}. Variance is stated only for material, only in a currency that was estimated, and only once the job is completed with a complete estimate.</p>

      {/* Material variance explained */}
      {c.materialBreakdown.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Material usage and price{final ? "" : " (to date)"}</CardTitle>
            <span className="text-xs text-muted-foreground">Usage = quantity difference × standard cost · Price = actual cost − issued quantity × standard cost</span>
          </CardHeader>
          <Table>
            <THead>
              <tr>
                <TH>Material</TH>
                <TH className="text-right">Expected</TH>
                <TH className="text-right">Issued</TH>
                <TH className="text-right">Over-issued</TH>
                <TH className="text-right">Usage variance</TH>
                <TH className="text-right">Price variance</TH>
              </tr>
            </THead>
            <TBody>
              {c.materialBreakdown.map((m) => (
                <TR key={m.materialItemId}>
                  <TD>{itemLabel(m.materialItemId)}</TD>
                  <TD className="text-right"><Quantity value={m.expectedQty} uom={m.uom} /></TD>
                  <TD className="text-right"><Quantity value={m.issuedQty} uom={m.uom} /></TD>
                  <TD className={`text-right ${Number(m.overIssuedQty) > 0 ? "text-status-warning" : ""}`}><Quantity value={m.overIssuedQty} uom={m.uom} /></TD>
                  {m.explanation.comparable ? (
                    <>
                      <TD className="text-right"><Money amount={m.explanation.usageVariance} currency={m.explanation.currency} /></TD>
                      <TD className="text-right"><Money amount={m.explanation.priceVariance} currency={m.explanation.currency} /></TD>
                    </>
                  ) : (
                    <TD colSpan={2} className="text-right text-xs text-muted-foreground">
                      <Unavailable reason={EXPLANATION_REASON[m.explanation.reason] ?? m.explanation.reason} />
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}

      {/* Adjustments */}
      <Card>
        <CardHeader>
          <CardTitle>Adjustments</CardTitle>
          {final ? adjustAction : null}
        </CardHeader>
        <CardContent className="text-sm">
          {c.adjustments.length === 0 ? (
            <p className="text-muted-foreground">{final ? "No corrections have been recorded against the frozen cost." : "Corrections can be recorded once the job is completed."}</p>
          ) : (
            <ul className="divide-y divide-border">
              {c.adjustments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                  <span>
                    <strong className="tabular-nums"><Money amount={a.amount} currency={a.currency} /></strong> to {a.component} — “{a.reason}”
                    <span className="text-muted-foreground"> · {actorName(a.createdById)}</span>
                  </span>
                  <LocalTime iso={a.createdAt} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Profit */}
      <Card>
        <CardHeader>
          <CardTitle>Margin</CardTitle>
          <Provenance kind="calculated" />
        </CardHeader>
        <CardContent className="text-sm">
          {c.profit.available ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
              <Row label="Quoted revenue"><Money amount={c.profit.revenue} currency={c.profit.currency} /> <span className="text-xs text-muted-foreground">(a quote — not recognised revenue)</span></Row>
              <Row label="Actual cost"><Money amount={c.profit.actualCost} currency={c.profit.currency} /> <span className="text-xs text-muted-foreground">material + labour{c.adjustments.length ? ", including adjustments" : ""}</span></Row>
              <Row label="Gross margin"><Money amount={c.profit.grossProfit} currency={c.profit.currency} /></Row>
              <Row label="Margin %">{c.profit.marginPercent ? `${c.profit.marginPercent}%` : <Unavailable />}</Row>
              <Row label="Not included"><span className="text-muted-foreground">Overhead (unavailable). This is margin over recorded cost, not net profit.</span></Row>
            </dl>
          ) : (
            <div className="space-y-2">
              <Unavailable reason="not stated" />
              <p className="text-muted-foreground">
                No margin is shown because {(c.profit.blockers && c.profit.blockers.length > 1 ? c.profit.blockers : [c.profit.reason]).map((r) => PROFIT_REASON[r] ?? r).join("; and ")}.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Conversion */}
      {convert ? (
        <Card>
          <CardHeader>
            <CardTitle>Convert to one currency (optional)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <form method="get" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="tab" value="costs" />
              <div className="space-y-1">
                <label htmlFor="convertTo" className="block text-xs font-medium text-muted-foreground">Convert to</label>
                <Select id="convertTo" name="convertTo" defaultValue={convert.convertTo ?? ""}>
                  <option value="">Choose…</option>
                  {convert.currencies.map((cur) => <option key={cur.code} value={cur.code}>{cur.code}</option>)}
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor="rateSource" className="block text-xs font-medium text-muted-foreground">Rate source</label>
                <Select id="rateSource" name="rateSource" defaultValue={convert.rateSource ?? ""}>
                  <option value="">Any recorded rate</option>
                  <option value="RBZ_OFFICIAL">RBZ official</option>
                  <option value="MARKET">Market</option>
                  <option value="MANUAL">Manual</option>
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor="asOf" className="block text-xs font-medium text-muted-foreground">Rate as of (optional)</label>
                <Input id="asOf" name="asOf" type="date" defaultValue={convert.asOf ?? ""} />
              </div>
              <Button type="submit" variant="secondary">Convert</Button>
            </form>
            {c.conversion ? (
              <div className="space-y-2 text-sm">
                <Provenance kind="calculated" label="Converted" />{" "}
                <span className="text-xs text-muted-foreground">{RATE_BASIS_LABEL[c.conversion.basis]}</span>
                {c.conversion.available && c.conversion.totals ? (
                  <p>
                    Material actual in {c.conversion.to}: <strong><Money amount={c.conversion.totals.actualMaterial} currency={c.conversion.to} /></strong>
                    {c.conversion.totals.actualLabour ? <> · Labour: <strong><Money amount={c.conversion.totals.actualLabour} currency={c.conversion.to} /></strong></> : null}
                  </p>
                ) : (
                  <Notice tone="warning">No recorded exchange rate covers every currency here{c.conversion.basis === "as_of_completion" ? " as of completion" : ""}, so no converted total is shown. Costs are never blended without a recorded rate.</Notice>
                )}
                <ul className="text-xs text-muted-foreground">
                  {c.conversion.groups.map((g) => (
                    <li key={g.currency}>
                      {g.currency}: {g.rate ? `1 ${g.currency} = ${g.rate.rate} ${c.conversion!.to} · effective ${formatDate(g.rate.asOfDate)} · ${g.rate.source} · recorded ${formatDateTimeUtc(g.rate.recordedAt)}` : g.currency === c.conversion!.to ? "already in target currency" : "no rate on record"}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
