"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/ui/notice";
import { CurrencySelect, FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { Currency, Item, ItemType } from "@/lib/api-types";
import { ITEM_TYPE_OPTIONS } from "@/lib/labels";
import { parseDecimalInput, requireText } from "@/lib/validate";
import { cn } from "@/lib/utils";

const TYPE_HELP: Record<ItemType, string> = {
  finished_good: "Something you build and can sell. Has a bill of materials.",
  wip: "A part built on the way to a finished good. Has a bill of materials.",
  raw_material: "Bought-in material consumed by jobs.",
  consumable: "Small supplies used up in production.",
  spare_part: "Parts held for maintenance and repair.",
};

// New item. The type is chosen first because it decides which other fields make
// sense (UX spec §2.2). Validation here is for usability; the server enforces
// the real rules (SKU uniqueness, price/currency pairing, sellable => price).
export function ItemForm({ currencies, canSeeCost }: { currencies: Currency[]; canSeeCost: boolean }) {
  const router = useRouter();
  const sub = useSubmission();
  const [itemType, setItemType] = useState<ItemType>("finished_good");
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [uom, setUom] = useState("pcs");
  const [reorder, setReorder] = useState("");
  const [cost, setCost] = useState("");
  const [costCurrency, setCostCurrency] = useState("");
  const [isSellable, setIsSellable] = useState(false);
  const [price, setPrice] = useState("");
  const [priceCurrency, setPriceCurrency] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});

  const errors = { ...sub.fieldErrors, ...local };
  const canSell = itemType === "finished_good" && canSeeCost;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problems: Record<string, string> = {};
    const skuErr = requireText(sku, "SKU", { max: 64 });
    if (skuErr) problems.sku = skuErr;
    const nameErr = requireText(name, "Name", { max: 200 });
    if (nameErr) problems.name = nameErr;
    const uomErr = requireText(uom, "Unit of measure", { max: 20 });
    if (uomErr) problems.uom = uomErr;

    const body: Record<string, unknown> = { sku: sku.trim(), name: name.trim(), uom: uom.trim(), itemType, isSellable: canSell && isSellable };
    if (description.trim()) body.description = description.trim();

    if (reorder.trim()) {
      const r = parseDecimalInput(reorder, { maxDecimals: 4, min: "nonnegative", label: "Reorder level" });
      if (r.ok) body.reorderThreshold = r.value;
      else problems.reorderThreshold = r.message;
    }
    if (canSeeCost && (cost.trim() || costCurrency)) {
      const c = parseDecimalInput(cost, { maxDecimals: 4, min: "nonnegative", label: "Standard cost" });
      if (!c.ok) problems.standardCost = c.message;
      else if (!costCurrency) problems.standardCostCurrency = "Choose the currency this cost is in.";
      else {
        body.standardCost = c.value;
        body.standardCostCurrency = costCurrency;
      }
    }
    if (canSell && isSellable) {
      const p = parseDecimalInput(price, { maxDecimals: 4, min: "positive", label: "Selling price" });
      if (!p.ok) problems.sellingPrice = p.message;
      else if (!priceCurrency) problems.sellingPriceCurrency = "Choose the currency for the selling price.";
      else {
        body.sellingPrice = p.value;
        body.sellingPriceCurrency = priceCurrency;
      }
    }
    setLocal(problems);
    if (Object.keys(problems).length > 0) {
      sub.fail("Fix the highlighted fields and try again.");
      return;
    }

    const result = await sub.run(() => apiRequest<Item>("/api/v1/items", { method: "POST", body }), {
      visibleFields: ["sku", "name", "uom", "reorderThreshold", "standardCost", "standardCostCurrency", "sellingPrice", "sellingPriceCurrency"],
    });
    if (result?.ok) {
      router.push(`/catalog/items/${result.data.id}`);
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-2xl space-y-5">
      <FormError message={sub.error} />

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">What kind of item is this?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ITEM_TYPE_OPTIONS.map(([value, label]) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 text-sm focus-within:ring-2 focus-within:ring-ring",
                itemType === value ? "border-primary bg-accent" : "border-border hover:bg-muted/50",
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name="itemType" value={value} checked={itemType === value} onChange={() => setItemType(value)} className="accent-[var(--primary)]" />
                {label}
              </span>
              <span className="pl-6 text-xs text-muted-foreground">{TYPE_HELP[value]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="sku" label="SKU" required error={errors.sku} hint="Unique within your organization. Can't be changed later.">
          <Input id="sku" value={sku} onChange={(e) => setSku(e.target.value)} aria-invalid={Boolean(errors.sku) || undefined} aria-describedby={describedBy("sku", { error: errors.sku, hint: "x" })} autoCapitalize="characters" spellCheck={false} />
        </Field>
        <Field id="uom" label="Unit of measure" required error={errors.uom} hint="For example pcs, kg, m.">
          <Input id="uom" value={uom} onChange={(e) => setUom(e.target.value)} aria-invalid={Boolean(errors.uom) || undefined} aria-describedby={describedBy("uom", { error: errors.uom, hint: "x" })} />
        </Field>
        <Field id="name" label="Name" required error={errors.name} className="sm:col-span-2">
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name) || undefined} aria-describedby={describedBy("name", { error: errors.name })} />
        </Field>
        <Field id="description" label="Description" error={errors.description} className="sm:col-span-2">
          <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field id="reorder" label="Reorder level" error={errors.reorderThreshold} hint="Stock below this shows as Low. Leave blank for none.">
          <Input id="reorder" inputMode="decimal" value={reorder} onChange={(e) => setReorder(e.target.value)} aria-invalid={Boolean(errors.reorderThreshold) || undefined} aria-describedby={describedBy("reorder", { error: errors.reorderThreshold, hint: "x" })} />
        </Field>
      </div>

      {canSeeCost ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="cost" label="Standard cost per unit" error={errors.standardCost} hint="Used to estimate job cost. Without it, this material is listed as unpriced.">
            <Input id="cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} aria-invalid={Boolean(errors.standardCost) || undefined} aria-describedby={describedBy("cost", { error: errors.standardCost, hint: "x" })} />
          </Field>
          <Field id="costCurrency" label="Cost currency" error={errors.standardCostCurrency}>
            <CurrencySelect id="costCurrency" value={costCurrency} onChange={setCostCurrency} currencies={currencies} invalid={Boolean(errors.standardCostCurrency)} describedBy={describedBy("costCurrency", { error: errors.standardCostCurrency })} />
          </Field>
        </div>
      ) : (
        <Notice tone="neutral">Standard cost and selling price are set by roles with cost access. You can add them later if your role changes.</Notice>
      )}

      {canSell ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={isSellable} onChange={(e) => setIsSellable(e.target.checked)} className="size-4 accent-[var(--primary)]" />
            This item is sold to customers
          </label>
          {isSellable ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="price" label="Selling price per unit" required error={errors.sellingPrice}>
                <Input id="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={Boolean(errors.sellingPrice) || undefined} aria-describedby={describedBy("price", { error: errors.sellingPrice })} />
              </Field>
              <Field id="priceCurrency" label="Price currency" required error={errors.sellingPriceCurrency}>
                <CurrencySelect id="priceCurrency" value={priceCurrency} onChange={setPriceCurrency} currencies={currencies} invalid={Boolean(errors.sellingPriceCurrency)} describedBy={describedBy("priceCurrency", { error: errors.sellingPriceCurrency })} />
              </Field>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex gap-2">
        <SubmitButton pending={sub.pending} pendingLabel="Creating…">
          Create item
        </SubmitButton>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={sub.pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
