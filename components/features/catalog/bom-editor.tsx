"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { Bom } from "@/lib/api-types";
import { parseDecimalInput } from "@/lib/validate";

export interface MaterialOption {
  id: string;
  name: string;
  sku: string;
  uom: string;
}

interface Row {
  key: number;
  materialItemId: string;
  quantity: string;
  uom: string;
}

// Creating a BOM version never edits an existing one: it posts a new draft
// that must be activated separately (ARCHITECTURE.md §4.C). The editor starts
// from a copy of the active version's lines so a small tweak isn't a re-entry.
export function BomEditor({
  productId,
  seedLines,
  materials,
  nextVersion,
  activeVersion,
}: {
  productId: string;
  seedLines: { materialItemId: string; quantity: string; uom: string }[];
  materials: MaterialOption[];
  nextVersion: number;
  activeVersion: number | null;
}) {
  const router = useRouter();
  const sub = useSubmission();
  const [nextKey, setNextKey] = useState(seedLines.length || 1);
  const [rows, setRows] = useState<Row[]>(
    seedLines.length > 0 ? seedLines.map((l, i) => ({ key: i, ...l })) : [{ key: 0, materialItemId: "", quantity: "", uom: "" }],
  );
  const [rowErrors, setRowErrors] = useState<Record<number, { material?: string; quantity?: string; uom?: string }>>({});
  const byId = new Map(materials.map((m) => [m.id, m]));

  function update(key: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function pickMaterial(key: number, id: string) {
    const m = byId.get(id);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, materialItemId: id, uom: r.uom || m?.uom || "" } : r)));
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const errs: Record<number, { material?: string; quantity?: string; uom?: string }> = {};
    const seen = new Set<string>();
    const lines: { materialItemId: string; quantity: number; uom: string }[] = [];
    for (const r of rows) {
      const e1: { material?: string; quantity?: string; uom?: string } = {};
      if (!r.materialItemId) e1.material = "Choose a material.";
      else if (seen.has(r.materialItemId)) e1.material = "This material is already on another line.";
      else seen.add(r.materialItemId);
      const q = parseDecimalInput(r.quantity, { maxDecimals: 4, min: "positive", label: "Quantity" });
      if (!q.ok) e1.quantity = q.message;
      if (!r.uom.trim()) e1.uom = "Required.";
      if (Object.keys(e1).length) errs[r.key] = e1;
      else if (q.ok) lines.push({ materialItemId: r.materialItemId, quantity: q.value, uom: r.uom.trim() });
    }
    setRowErrors(errs);
    if (Object.keys(errs).length > 0) {
      sub.fail("Fix the highlighted lines and try again.");
      return;
    }
    const result = await sub.run(() => apiRequest<Bom>(`/api/v1/items/${productId}/boms`, { method: "POST", body: { lines } }));
    if (result?.ok) {
      router.push(`/catalog/items/${productId}?tab=bom`);
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <Notice tone="info" title={`Saving creates version ${nextVersion}`}>
        {activeVersion !== null ? `Version ${activeVersion} stays active until you activate this one. ` : "Nothing uses it until you activate it. "}
        Jobs already created keep the version they were created with. Quantities are per one unit produced.
      </Notice>
      <FormError message={sub.error} />

      <ul className="space-y-3">
        {rows.map((r, idx) => {
          const m = byId.get(r.materialItemId);
          const err = rowErrors[r.key] ?? {};
          const mismatch = m && r.uom.trim() && m.uom !== r.uom.trim();
          return (
            <li key={r.key} className="rounded-lg border border-border bg-card p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start">
                <div className="space-y-1">
                  <label htmlFor={`m-${r.key}`} className="text-xs font-medium text-muted-foreground">
                    Material {idx + 1}
                  </label>
                  <Select id={`m-${r.key}`} value={r.materialItemId} onChange={(e) => pickMaterial(r.key, e.target.value)} aria-invalid={Boolean(err.material) || undefined}>
                    <option value="">Choose material…</option>
                    {materials.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ({o.sku})
                      </option>
                    ))}
                  </Select>
                  {err.material ? <p role="alert" className="text-xs text-destructive">{err.material}</p> : null}
                </div>
                <div className="space-y-1">
                  <label htmlFor={`q-${r.key}`} className="text-xs font-medium text-muted-foreground">
                    Quantity per unit
                  </label>
                  <Input id={`q-${r.key}`} inputMode="decimal" value={r.quantity} onChange={(e) => update(r.key, { quantity: e.target.value })} aria-invalid={Boolean(err.quantity) || undefined} />
                  {err.quantity ? <p role="alert" className="text-xs text-destructive">{err.quantity}</p> : null}
                </div>
                <div className="space-y-1">
                  <label htmlFor={`u-${r.key}`} className="text-xs font-medium text-muted-foreground">
                    Unit
                  </label>
                  <Input id={`u-${r.key}`} value={r.uom} onChange={(e) => update(r.key, { uom: e.target.value })} aria-invalid={Boolean(err.uom) || undefined} />
                  {err.uom ? <p role="alert" className="text-xs text-destructive">{err.uom}</p> : null}
                </div>
                <div className="sm:pt-5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove material line ${idx + 1}`}
                    disabled={rows.length === 1 || sub.pending}
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              {mismatch ? (
                <p className="mt-2 text-xs text-status-warning">
                  This line uses {r.uom.trim()}, but the material is stocked in {m?.uom}. Jobs can&apos;t price this line until the units match.
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Button
        type="button"
        variant="outline"
        disabled={sub.pending || rows.length >= 200}
        onClick={() => {
          setRows((rs) => [...rs, { key: nextKey, materialItemId: "", quantity: "", uom: "" }]);
          setNextKey((k) => k + 1);
        }}
      >
        <Plus /> Add line
      </Button>

      <div className="flex gap-2 border-t border-border pt-4">
        <SubmitButton pending={sub.pending} pendingLabel="Saving…">
          Save as version {nextVersion}
        </SubmitButton>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={sub.pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
