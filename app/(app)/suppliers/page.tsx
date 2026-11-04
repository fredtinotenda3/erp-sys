import Link from "next/link";
import { Plus } from "lucide-react";

import { listSuppliers, SUPPLIER_STATUS_VALUES, type SupplierStatus } from "../../../src/server/modules/suppliers/supplier-service";
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

export const metadata = { title: "Suppliers · Operis" };
const PAGE_SIZE = 25;

interface SupplierRow {
  id: string;
  name: string;
  status: string;
  contact: string | null;
}

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getPageContext();
  if (!ctx.can("supplier:read")) return <AccessDenied what="suppliers" />;

  const sp = await searchParams;
  const search = param(sp.q)?.trim() || undefined;
  const sParam = param(sp.status);
  const status = sParam && (SUPPLIER_STATUS_VALUES as readonly string[]).includes(sParam) ? (sParam as SupplierStatus) : undefined;
  const page = Math.max(1, Number.parseInt(param(sp.page) ?? "1", 10) || 1);

  const result = await load<SupplierRow[]>(() => listSuppliers(ctx.session, { status, search }));
  const filtered = Boolean(search || status);
  const rows = result.ok ? result.data : [];
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <>
      <PageHeader
        title="Suppliers"
        description="The vendors you buy materials and services from."
        actions={
          ctx.can("supplier:create") ? (
            <Link href="/suppliers/new" className={buttonVariants()}>
              <Plus /> New supplier
            </Link>
          ) : null
        }
      />
      <FilterBar resetHref="/suppliers">
        <FilterField id="q" label="Search by name">
          <Input id="q" name="q" defaultValue={search ?? ""} placeholder="e.g. Acme Supplies" />
        </FilterField>
        <FilterField id="status" label="Status">
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">All</option>
            {SUPPLIER_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>{humanize(s)}</option>
            ))}
          </Select>
        </FilterField>
      </FilterBar>

      {!result.ok ? (
        <LoadFailure status={result.status} message={result.message} what="suppliers" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No suppliers match these filters" : "No suppliers yet"}
          action={!filtered && ctx.can("supplier:create") ? <Link href="/suppliers/new" className={buttonVariants()}>Add the first supplier</Link> : null}
        >
          {filtered ? "Clear the filters to see every supplier." : "Add a supplier so purchase orders and receipts can be linked to them."}
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
              {slice.map((s) => (
                <TR key={s.id}>
                  <TD>
                    <Link href={`/suppliers/${s.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{s.name}</Link>
                  </TD>
                  <TD>{s.contact ?? <span className="text-muted-foreground">—</span>}</TD>
                  <TD><ActiveBadge active={s.status === "active"} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination basePath="/suppliers" params={{ q: search, status }} page={page} pageSize={PAGE_SIZE} total={rows.length} />
        </Card>
      )}
    </>
  );
}
