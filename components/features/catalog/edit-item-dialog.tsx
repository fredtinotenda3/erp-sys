"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Modal } from "@/components/ui/modal";
import { Notice } from "@/components/ui/notice";
import { CurrencySelect, FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { Currency, Item } from "@/lib/api-types";
import { parseDecimalInput, requireText } from "@/lib/validate";

// Edits only what the API allows (SKU and type are fixed). Sends just the
// fields that changed, so an untouched price is never rewritten.
export function EditItemDialog({ item, currencies, canSeeCost }: { item: Item; currencies: Currency[]; canSeeCost: boolean }) {
  const router = useRouter();
  const sub = useSubmission();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description ?? "");
  const [reorder, setReorder] = useState(item.reorderThreshold ?? "");
  const [isActive, setIsActive] = useState(item.isActive);
  const [understood, setUnderstood] = useState(false);
  const [cost, setCost] = useState(item.standardCost ?? "");
  const [costCurrency, setCostCurrency] = useState(item.standardCostCurrency ?? "");
  const [isSellable, setIsSellable] = useState(item.isSellable);
  const [price, setPrice] = useState(item.sellingPrice ?? "");
  const [priceCurrency, setPriceCurrency] = useState(item.sellingPriceCurrency ?? "");
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };
  const deactivating = item.isActive && !isActive;
  const canEditSale = canSeeCost && item.itemType === "finished_good";

  function close() {
    if (sub.pending) return;
    setOpen(false);
    sub.clear();
    setLocal({});
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    const body: Record<string, unknown> = {};

    const nameErr = requireText(name, "Name", { max: 200 });
    if (nameErr) problems.name = nameErr;
    else if (name.trim() !== item.name) body.name = name.trim();

    if (description.trim() !== (item.description ?? "")) body.description = description.trim();

    if (reorder.trim() !== (item.reorderThreshold ?? "")) {
      if (reorder.trim() === "") body.reorderThreshold = null;
      else {
        const r = parseDecimalInput(reorder, { maxDecimals: 4, min: "nonnegative", label: "Reorder level" });
        if (r.ok) body.reorderThreshold = r.value;
        else problems.reorderThreshold = r.message;
      }
    }
    if (isActive !== item.isActive) body.isActive = isActive;
    if (deactivating && !understood) problems.isActive = "Confirm that you understand before deactivating.";

    if (canSeeCost && (cost !== (item.standardCost ?? "") || costCurrency !== (item.standardCostCurrency ?? ""))) {
      const c = parseDecimalInput(String(cost), { maxDecimals: 4, min: "nonnegative", label: "Standard cost" });
      if (!c.ok) problems.standardCost = c.message;
      else if (!costCurrency) problems.standardCostCurrency = "Choose the currency this cost is in.";
      else {
        body.standardCost = c.value;
        body.standardCostCurrency = costCurrency;
      }
    }
    if (canEditSale) {
      if (isSellable !== item.isSellable) body.isSellable = isSellable;
      const priceChanged = price !== (item.sellingPrice ?? "") || priceCurrency !== (item.sellingPriceCurrency ?? "");
      if (isSellable && (priceChanged || !item.isSellable)) {
        const p = parseDecimalInput(String(price), { maxDecimals: 4, min: "positive", label: "Selling price" });
        if (!p.ok) problems.sellingPrice = p.message;
        else if (!priceCurrency) problems.sellingPriceCurrency = "Choose the currency for the selling price.";
        else {
          body.sellingPrice = p.value;
          body.sellingPriceCurrency = priceCurrency;
        }
      }
    }

    setLocal(problems);
    if (Object.keys(problems).length > 0) {
      sub.fail("Fix the highlighted fields and try again.");
      return;
    }
    if (Object.keys(body).length === 0) {
      sub.fail("Nothing has changed.");
      return;
    }
    const result = await sub.run(() => apiRequest<Item>(`/api/v1/items/${item.id}`, { method: "PATCH", body }), {
      visibleFields: ["name", "reorderThreshold", "standardCost", "standardCostCurrency", "sellingPrice", "sellingPriceCurrency"],
    });
    if (result?.ok) {
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Pencil /> Edit
      </Button>
      <Modal
        open={open}
        onClose={close}
        dismissible={!sub.pending}
        title={`Edit ${item.sku}`}
        description="SKU and item type can't be changed once an item exists."
        footer={
          <>
            <Button type="button" variant="ghost" onClick={close} disabled={sub.pending}>
              Cancel
            </Button>
            <SubmitButton form="edit-item-form" pending={sub.pending} pendingLabel="Saving…" variant={deactivating ? "destructive" : "primary"}>
              {deactivating ? "Deactivate and save" : "Save changes"}
            </SubmitButton>
          </>
        }
      >
        <form id="edit-item-form" onSubmit={onSubmit} noValidate className="space-y-4">
          <FormError message={sub.error} />
          <Field id="e-name" label="Name" required error={errors.name}>
            <Input id="e-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name) || undefined} aria-describedby={describedBy("e-name", { error: errors.name })} />
          </Field>
          <Field id="e-desc" label="Description">
            <Textarea id="e-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field id="e-reorder" label="Reorder level" error={errors.reorderThreshold} hint="Clear the field to remove the reorder level.">
            <Input id="e-reorder" inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} aria-invalid={Boolean(errors.reorderThreshold) || undefined} aria-describedby={describedBy("e-reorder", { error: errors.reorderThreshold, hint: "x" })} />
          </Field>
          {canSeeCost ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="e-cost" label="Standard cost per unit" error={errors.standardCost}>
                <Input id="e-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} aria-invalid={Boolean(errors.standardCost) || undefined} aria-describedby={describedBy("e-cost", { error: errors.standardCost })} />
              </Field>
              <Field id="e-costc" label="Cost currency" error={errors.standardCostCurrency}>
                <CurrencySelect id="e-costc" value={costCurrency} onChange={setCostCurrency} currencies={currencies} invalid={Boolean(errors.standardCostCurrency)} describedBy={describedBy("e-costc", { error: errors.standardCostCurrency })} />
              </Field>
            </div>
          ) : null}
          {canEditSale ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={isSellable} onChange={(e) => setIsSellable(e.target.checked)} className="size-4 accent-[var(--primary)]" />
                Sold to customers
              </label>
              {isSellable ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="e-price" label="Selling price per unit" required error={errors.sellingPrice}>
                    <Input id="e-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={Boolean(errors.sellingPrice) || undefined} aria-describedby={describedBy("e-price", { error: errors.sellingPrice })} />
                  </Field>
                  <Field id="e-pricec" label="Price currency" required error={errors.sellingPriceCurrency}>
                    <CurrencySelect id="e-pricec" value={priceCurrency} onChange={setPriceCurrency} currencies={currencies} invalid={Boolean(errors.sellingPriceCurrency)} describedBy={describedBy("e-pricec", { error: errors.sellingPriceCurrency })} />
                  </Field>
                </div>
              ) : item.isSellable ? (
                <Notice tone="warning">Turning this off also clears the selling price.</Notice>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={isActive} onChange={(e) => { setIsActive(e.target.checked); setUnderstood(false); }} className="size-4 accent-[var(--primary)]" />
              Active
            </label>
            {deactivating ? (
              <div className="space-y-2">
                <Notice tone="warning">Inactive items can&apos;t be used for new jobs, receipts or stock adjustments. Existing jobs, BOMs and history are kept.</Notice>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="size-4 accent-[var(--primary)]" />
                  I understand and want to deactivate this item
                </label>
                {errors.isActive ? <p role="alert" className="text-xs text-destructive">{errors.isActive}</p> : null}
              </div>
            ) : null}
          </div>
        </form>
      </Modal>
    </>
  );
}
