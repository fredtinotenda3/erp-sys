import { listExchangeRates } from "../../../../src/server/modules/costing/exchange-rate-service";
import { ExchangeRateForm } from "../../../../components/features/costing/exchange-rate-form";
import { FilterBar, FilterField } from "../../../../components/features/shared/filter-bar";
import { Card, CardContent, CardHeader, CardTitle } from "../../../../components/ui/card";
import { LocalTime } from "../../../../components/ui/local-time";
import { Notice } from "../../../../components/ui/notice";
import { PageHeader } from "../../../../components/ui/page-header";
import { Select } from "../../../../components/ui/select";
import { AccessDenied, EmptyState, LoadFailure } from "../../../../components/ui/states";
import { Table, TBody, TD, TH, THead, TR } from "../../../../components/ui/table";
import { formatDate } from "../../../../lib/format";
import { getPageContext, load, param } from "../../../../lib/server/page-context";
import { loadCurrencies, loadUsers } from "../../../../lib/server/lookups";
import type { ExchangeRate } from "../../../../lib/api-types";

export const metadata = { title: "Exchange rates · Operis" };

const SOURCE_LABEL: Record<string, string> = { RBZ_OFFICIAL: "RBZ official", MARKET: "Market", MANUAL: "Manual" };

export default async function ExchangeRatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("exchange_rate:read")) return <AccessDenied what="exchange rates" />;

  const sp = await searchParams;
  const upper = (v: string | undefined) => (v && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : undefined);
  const baseCurrency = upper(param(sp.base));
  const quoteCurrency = upper(param(sp.quote));
  const src = param(sp.source);
  const source = src && src in SOURCE_LABEL ? src : undefined;
  const canRecord = ctx.can("exchange_rate:create");

  const [rates, currencies, users] = await Promise.all([
    load<ExchangeRate[]>(() => listExchangeRates(ctx.session, { baseCurrency, quoteCurrency, source })),
    loadCurrencies(),
    loadUsers(ctx),
  ]);
  const who = (id: string | null) => (id ? (users.byId.get(id)?.fullName ?? (users.available ? "Former user" : "A user")) : "System");

  // "In force now" = newest row per pair+source (rows arrive newest-first).
  const seen = new Set<string>();
  const current = new Set<string>();
  if (rates.ok) {
    for (const r of rates.data) {
      const k = `${r.baseCurrency}|${r.quoteCurrency}|${r.source}`;
      if (!seen.has(k)) {
        seen.add(k);
        current.add(r.id);
      }
    }
  }

  return (
    <>
      <PageHeader
        title="Exchange rates"
        description="Rates your organization has recorded. Each is permanent and cited by any cost conversion that uses it."
        crumbs={[{ label: "Costing" }, { label: "Exchange rates" }]}
      />
      <Notice tone="info" className="mb-5" title="How rates are read">
        A rate says how many units of the <strong>quote</strong> currency one unit of the <strong>base</strong> currency buys. Inverse rates are never derived: record each direction you need. Completed jobs always convert with the rate that was on record when they completed.
      </Notice>

      {canRecord ? (
        <Card className="mb-5">
          <CardHeader>
            <CardTitle>Record a rate</CardTitle>
          </CardHeader>
          <CardContent>
            {currencies.length < 2 ? <Notice tone="danger">The currency list couldn&apos;t be loaded.</Notice> : <ExchangeRateForm currencies={currencies} today={new Date().toISOString().slice(0, 10)} />}
          </CardContent>
        </Card>
      ) : (
        <Notice tone="neutral" className="mb-5">Only Finance and Owner/Admin roles can record rates.</Notice>
      )}

      <FilterBar resetHref="/costing/exchange-rates">
        <FilterField id="base" label="Base">
          <Select id="base" name="base" defaultValue={baseCurrency ?? ""}>
            <option value="">Any</option>
            {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </Select>
        </FilterField>
        <FilterField id="quote" label="Quote">
          <Select id="quote" name="quote" defaultValue={quoteCurrency ?? ""}>
            <option value="">Any</option>
            {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
          </Select>
        </FilterField>
        <FilterField id="source" label="Source">
          <Select id="source" name="source" defaultValue={source ?? ""}>
            <option value="">Any</option>
            {Object.entries(SOURCE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </FilterField>
      </FilterBar>

      {!rates.ok ? (
        <LoadFailure status={rates.status} message={rates.message} what="exchange rates" />
      ) : rates.data.length === 0 ? (
        <EmptyState title="No rates recorded">Without a recorded rate, costs in different currencies are shown separately and never combined.</EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Pair</TH>
                <TH className="text-right">Rate</TH>
                <TH>Effective</TH>
                <TH>Source</TH>
                <TH>Recorded</TH>
                <TH>By</TH>
                <TH></TH>
              </tr>
            </THead>
            <TBody>
              {rates.data.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap font-medium">1 {r.baseCurrency} → {r.quoteCurrency}</TD>
                  <TD className="text-right tabular-nums">{r.rate.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}</TD>
                  <TD>{formatDate(r.asOfDate)}</TD>
                  <TD>{SOURCE_LABEL[r.source] ?? r.source}</TD>
                  <TD><LocalTime iso={r.recordedAt} /></TD>
                  <TD>{who(r.recordedById)}</TD>
                  <TD>{current.has(r.id) ? <span className="text-xs text-status-success">In force</span> : <span className="text-xs text-muted-foreground">Superseded</span>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">Newest first, up to 200 rows. Superseded rates are kept: completed jobs still cite the rate they used.</p>
        </Card>
      )}
    </>
  );
}
