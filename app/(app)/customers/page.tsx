import Link from "next/link";
import { Plus } from "lucide-react";

import { listCustomers, CUSTOMER_STATUS_VALUES, type CustomerStatus } from "../../../src/server/modules/customers/customer-service";
import { buttonVariants } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { PageHeader } from "../../../components/ui/page-header";
import { AccessDenied, EmptyState, LoadFailure } from "../../../components/ui/states";
import { ActiveBadge } from "../../../components/ui/status-badge";
import { Table, TBody, TD, TH, THead, TR } from "../../../components/ui/table";
import { FilterBar, FilterField } from "../../../components/features/shared/filter-bar";
import { Pagination } from "../../../components/features/shared/pagination";
import { humanize } from "../../../lib/format";
import { getPageContext, load, param } from "../../../lib/server/page-context";

export const metadata = { title: "Customers · Operis" };
const PAGE_SIZE = 25;

interface CustomerRow {
  id: string;
  name: string;
  status: string;
  contact: string | null;
}

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("customer:read")) return <AccessDenied what="customers" />;

  const sp = await searchParams;
  const search = param(sp.q)?.trim() || undefined;
  const sParam = param(sp.status);
  const status = sParam && (CUSTOMER_STATUS_VALUES as readonly string[]).includes(sParam) ? (sParam as CustomerStatus) : undefined;
  const page = Math.max(1, Number.parseInt(param(sp.page) ?? "1", 10) || 1);

  const result = await load<CustomerRow[]>(() => listCustomers(ctx.session, { status, search }));
  const filtered = Boolean(search || status);
  const rows = result.ok ? result.data : [];
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <PageHeader
        title="Customers"
        description="The people and companies you make things for."
        actions={
          ctx.can("customer:create") ? (
            <Link href="/customers/new" className={buttonVariants()}>
              <Plus /> New customer
            </Link>
          ) : null
        }
      />
      <FilterBar resetHref="/customers">
        <FilterField id="q" label="Search by name">
          <Input id="q" name="q" defaultValue={search ?? ""} placeholder="e.g. Acme" />
        </FilterField>
        <FilterField id="status" label="Status">
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">All</option>
            {CUSTOMER_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>{humanize(s)}</option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      {!result.ok ? (
        <LoadFailure status={result.status} message={result.message} what="customers" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No customers match these filters" : "No customers yet"}
          action={!filtered && ctx.can("customer:create") ? <Link href="/customers/new" className={buttonVariants()}>Add the first customer</Link> : null}
        >
          {filtered ? "Clear the filters to see every customer." : "Add a customer so orders and jobs can be linked to them."}
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Contact</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {slice.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link href={`/customers/${c.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{c.name}</Link>
                  </TD>
                  <TD>{c.contact ?? <span className="text-muted-foreground">—</span>}</TD>
                  <TD><ActiveBadge active={c.status === "active"} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination basePath="/customers" params={{ q: search, status }} page={page} pageSize={PAGE_SIZE} total={rows.length} />
        </Card>
      )}
    </>
  );
}
