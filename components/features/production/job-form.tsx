"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import { CurrencySelect, FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { Bom, Currency, Job } from "@/lib/api-types";
import { formatQuantity } from "@/lib/format";
import { parseDecimalInput } from "@/lib/validate";

export interface ProductOption {
  id: string;
  name: string;
  sku: string;
  uom: string;
}

type BomState = { status: "idle" } | { status: "loading" } | { status: "none" } | { status: "error"; message: string } | { status: "ok"; bom: Bom };

// A job is created from a product's ACTIVE bom (the server snapshots it). The
// preview below is read from the real endpoint so the planner sees what will be
// snapshotted; if there's no active BOM, the server would refuse, so we say so.
// NOTE: job creation has no clientRequestId in the backend, so a duplicate
// submit can't be de-duplicated server-side. We prevent it client-side (single
// in-flight guard, navigate away on success) and warn after an unknown outcome.
export function JobForm({
  branches,
  products,
  customers,
  currencies,
  canSeeCost,
  defaultBranchId,
  materialNames,
}: {
  branches: { id: string; name: string }[];
  products: ProductOption[];
  customers: { id: string; name: string }[] | null;
  currencies: Currency[];
  canSeeCost: boolean;
  defaultBranchId: string | null;
  materialNames: Record<string, string>;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [branchId, setBranchId] = useState(defaultBranchId ?? (branches.length === 1 ? branches[0]!.id : ""));
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [quote, setQuote] = useState("");
  const [quoteCurrency, setQuoteCurrency] = useState("");
  const [bom, setBom] = useState<BomState>({ status: "idle" });
  const [local, setLocal] = useState<Record<string, string>>({});
  const [uncertain, setUncertain] = useState(false);
  const errors = { ...sub.fieldErrors, ...local };

  async function pickProduct(id: string) {
    setProductId(id);
    if (!id) return setBom({ status: "idle" });
    setBom({ status: "loading" });
    const r = await apiRequest<Bom>(`/api/v1/items/${id}/boms/active`);
    setBom((cur) => {
      void cur;
      if (r.ok) return { status: "ok", bom: r.data };
      return r.status === 404 ? { status: "none" } : { status: "error", message: r.error.message };
    });
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!branchId) problems.branchId = "Choose a branch.";
    if (!productId) problems.productItemId = "Choose a product.";
    const q = parseDecimalInput(qty, { maxDecimals: 4, min: "positive", label: "Planned quantity" });
    if (!q.ok) problems.plannedQty = q.message;
    if (start && end && end < start) problems.plannedEnd = "The planned end can't be before the planned start.";
    const body: Record<string, unknown> = { branchId, productItemId: productId };
    if (q.ok) body.plannedQty = q.value;
    if (start) body.plannedStart = start;
    if (end) body.plannedEnd = end;
    if (customerId) body.customerId = customerId;
    if (canSeeCost && (quote.trim() || quoteCurrency)) {
      const a = parseDecimalInput(quote, { maxDecimals: 4, min: "nonnegative", label: "Quoted amount" });
      if (!a.ok) problems.quotedAmount = a.message;
      else if (!quoteCurrency) problems.quotedCurrency = "Choose the currency of the quote.";
      else {
        body.quotedAmount = a.value;
        body.quotedCurrency = quoteCurrency;
      }
    }
    setLocal(problems);
    if (Object.keys(problems).length > 0) return sub.fail("Fix the highlighted fields and try again.");
    if (bom.status === "none") return sub.fail("This product has no active bill of materials, so a job can't be created yet.");

    const result = await sub.run(() => apiRequest<Job>("/api/v1/production-jobs", { method: "POST", body }), {
      visibleFields: ["branchId", "productItemId", "plannedQty", "plannedStart", "plannedEnd", "quotedAmount", "quotedCurrency"],
    });
    if (!result) return;
    if (result.ok) {
      router.push(`/production/jobs/${result.data.id}`);
      router.refresh();
    } else if (result.network || result.status >= 500) {
      setUncertain(true);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-2xl space-y-5">
      <FormError message={sub.error} />
      {uncertain ? (
        <Notice tone="warning" title="Check before retrying">
          The server didn&apos;t confirm whether the job was created. Look at the <Link className="underline" href="/production/jobs">jobs list</Link> first; submitting again could create a second job.
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="branch" label="Branch" required error={errors.branchId}>
          <Select id="branch" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-invalid={Boolean(errors.branchId) || undefined} aria-describedby={describedBy("branch", { error: errors.branchId })}>
            <option value="">Choose branch…</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="product" label="Product" required error={errors.productItemId} hint="Finished goods and work-in-progress items.">
          <Select id="product" value={productId} onChange={(e) => void pickProduct(e.target.value)} aria-invalid={Boolean(errors.productItemId) || undefined} aria-describedby={describedBy("product", { error: errors.productItemId, hint: "x" })}>
            <option value="">Choose product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {bom.status === "loading" ? <p className="text-sm text-muted-foreground" role="status">Loading the active bill of materials…</p> : null}
      {bom.status === "none" ? (
        <Notice tone="warning" title="No active BOM">
          Activate a bill of materials for this product before creating a job.
        </Notice>
      ) : null}
      {bom.status === "error" ? <Notice tone="danger">Couldn&apos;t load the BOM: {bom.message}</Notice> : null}
      {bom.status === "ok" ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <p className="font-medium">Will snapshot BOM version {bom.bom.version}</p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {bom.bom.lines.map((l) => (
              <li key={l.id}>
                {materialNames[l.materialItemId] ?? `Item ${l.materialItemId.slice(0, 8)}`} — {formatQuantity(l.quantity, l.uom)} per unit
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="qty" label="Planned quantity" required error={errors.plannedQty}>
          <Input id="qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} aria-invalid={Boolean(errors.plannedQty) || undefined} aria-describedby={describedBy("qty", { error: errors.plannedQty })} />
        </Field>
        <Field id="start" label="Planned start" error={errors.plannedStart}>
          <Input id="start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field id="end" label="Planned end" error={errors.plannedEnd}>
          <Input id="end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} aria-invalid={Boolean(errors.plannedEnd) || undefined} aria-describedby={describedBy("end", { error: errors.plannedEnd })} />
        </Field>
      </div>

      {customers ? (
        <Field id="customer" label="Customer" hint="Optional.">
          <Select id="customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">No customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      {canSeeCost ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="quote" label="Quoted amount" error={errors.quotedAmount} hint="Optional. Used for profit once the job is costed.">
            <Input id="quote" inputMode="decimal" value={quote} onChange={(e) => setQuote(e.target.value)} aria-invalid={Boolean(errors.quotedAmount) || undefined} aria-describedby={describedBy("quote", { error: errors.quotedAmount, hint: "x" })} />
          </Field>
          <Field id="quoteCurrency" label="Quote currency" error={errors.quotedCurrency}>
            <CurrencySelect id="quoteCurrency" value={quoteCurrency} onChange={setQuoteCurrency} currencies={currencies} invalid={Boolean(errors.quotedCurrency)} describedBy={describedBy("quoteCurrency", { error: errors.quotedCurrency })} />
          </Field>
        </div>
      ) : null}

      <div className="flex gap-2">
        <SubmitButton pending={sub.pending} pendingLabel="Creating…" disabled={bom.status === "loading" || bom.status === "none"}>
          Create job
        </SubmitButton>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={sub.pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
