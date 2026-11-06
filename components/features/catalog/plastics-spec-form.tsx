"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { PlasticsMaterialAttributesView, PlasticsProductSpecView } from "@/lib/api-types";

function numOrUndef(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** raw_material / consumable side -- polymer grade, resin spec, colour, recycled content, etc. */
export function PlasticsMaterialAttributesForm({ itemId, initial, canManage }: { itemId: string; initial: PlasticsMaterialAttributesView | null; canManage: boolean }) {
  const router = useRouter();
  const sub = useSubmission();
  const [polymerGrade, setPolymerGrade] = useState(initial?.polymerGrade ?? "");
  const [resinSpec, setResinSpec] = useState(initial?.resinSpec ?? "");
  const [colourMasterbatch, setColourMasterbatch] = useState(initial?.colourMasterbatch ?? "");
  const [additiveNotes, setAdditiveNotes] = useState(initial?.additiveNotes ?? "");
  const [recycledContentPct, setRecycledContentPct] = useState(initial?.recycledContentPct ?? "");
  const [supplierMaterialRef, setSupplierMaterialRef] = useState(initial?.supplierMaterialRef ?? "");
  const [materialCertificateReference, setMaterialCertificateReference] = useState(initial?.materialCertificateReference ?? "");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const result = await sub.run(() =>
      apiRequest(`/api/v1/items/${itemId}/plastics-material-attributes`, {
        method: "PUT",
        body: {
          polymerGrade: polymerGrade.trim() || null,
          resinSpec: resinSpec.trim() || null,
          colourMasterbatch: colourMasterbatch.trim() || null,
          additiveNotes: additiveNotes.trim() || null,
          recycledContentPct: numOrUndef(String(recycledContentPct)) ?? null,
          supplierMaterialRef: supplierMaterialRef.trim() || null,
          materialCertificateReference: materialCertificateReference.trim() || null,
        },
      }),
    );
    if (result?.ok) router.refresh();
  }

  if (!canManage && !initial) {
    return <p className="text-sm text-muted-foreground">No plastics material attributes recorded for this item.</p>;
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><FormError message={sub.error} /></div>
      <Field id="pm-grade" label="Polymer grade" hint="e.g. PET, HDPE, PP — not hardcoded to any one resin">
        <Input id="pm-grade" value={polymerGrade} onChange={(e) => setPolymerGrade(e.target.value)} disabled={!canManage} maxLength={60} />
      </Field>
      <Field id="pm-resin-spec" label="Resin spec">
        <Input id="pm-resin-spec" value={resinSpec} onChange={(e) => setResinSpec(e.target.value)} disabled={!canManage} maxLength={200} />
      </Field>
      <Field id="pm-colour" label="Colour / masterbatch">
        <Input id="pm-colour" value={colourMasterbatch} onChange={(e) => setColourMasterbatch(e.target.value)} disabled={!canManage} maxLength={100} />
      </Field>
      <Field id="pm-recycled" label="Recycled content %" hint="0–100">
        <Input id="pm-recycled" type="number" min="0" max="100" step="0.01" value={recycledContentPct} onChange={(e) => setRecycledContentPct(e.target.value)} disabled={!canManage} />
      </Field>
      <Field id="pm-supplier-ref" label="Supplier material reference">
        <Input id="pm-supplier-ref" value={supplierMaterialRef} onChange={(e) => setSupplierMaterialRef(e.target.value)} disabled={!canManage} maxLength={100} />
      </Field>
      <Field id="pm-cert" label="Material certificate reference" hint="A reference or URL -- this system has no file-upload feature, so a certificate itself can't be attached here">
        <Input id="pm-cert" value={materialCertificateReference} onChange={(e) => setMaterialCertificateReference(e.target.value)} disabled={!canManage} maxLength={500} />
      </Field>
      <div className="sm:col-span-2">
        <Field id="pm-additives" label="Additive notes">
          <Textarea id="pm-additives" rows={2} value={additiveNotes} onChange={(e) => setAdditiveNotes(e.target.value)} disabled={!canManage} maxLength={500} />
        </Field>
      </div>
      {canManage ? (
        <div className="sm:col-span-2">
          <SubmitButton pending={sub.pending} pendingLabel="Saving…">Save material attributes</SubmitButton>
        </div>
      ) : null}
    </form>
  );
}

/** finished_good / wip side -- product type, resin, colour, weight, capacity, dimensions, neck/closure. */
export function PlasticsProductSpecForm({ itemId, initial, canManage }: { itemId: string; initial: PlasticsProductSpecView | null; canManage: boolean }) {
  const router = useRouter();
  const sub = useSubmission();
  const [productType, setProductType] = useState(initial?.productType ?? "");
  const [resinType, setResinType] = useState(initial?.resinType ?? "");
  const [colour, setColour] = useState(initial?.colour ?? "");
  const [nominalWeightGrams, setNominalWeightGrams] = useState(initial?.nominalWeightGrams ?? "");
  const [capacityMl, setCapacityMl] = useState(initial?.capacityMl ?? "");
  const [heightMm, setHeightMm] = useState(initial?.heightMm ?? "");
  const [diameterMm, setDiameterMm] = useState(initial?.diameterMm ?? "");
  const [neckFinish, setNeckFinish] = useState(initial?.neckFinish ?? "");
  const [closureCompatibilityNotes, setClosureCompatibilityNotes] = useState(initial?.closureCompatibilityNotes ?? "");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!productType.trim()) return sub.fail("Product type is required.", { productType: "Required." });
    const result = await sub.run(() =>
      apiRequest(`/api/v1/items/${itemId}/plastics-product-spec`, {
        method: "PUT",
        body: {
          productType: productType.trim(),
          resinType: resinType.trim() || null,
          colour: colour.trim() || null,
          nominalWeightGrams: numOrUndef(String(nominalWeightGrams)) ?? null,
          capacityMl: numOrUndef(String(capacityMl)) ?? null,
          heightMm: numOrUndef(String(heightMm)) ?? null,
          diameterMm: numOrUndef(String(diameterMm)) ?? null,
          neckFinish: neckFinish.trim() || null,
          closureCompatibilityNotes: closureCompatibilityNotes.trim() || null,
        },
      }),
    );
    if (result?.ok) router.refresh();
  }

  if (!canManage && !initial) {
    return <p className="text-sm text-muted-foreground">No plastics product spec recorded for this item.</p>;
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><FormError message={sub.error} /></div>
      <Field id="pp-type" label="Product type" required error={sub.fieldErrors.productType} hint="e.g. bottle, preform, cap, jar -- not one hardcoded shape">
        <Input id="pp-type" value={productType} onChange={(e) => setProductType(e.target.value)} disabled={!canManage} maxLength={60} />
      </Field>
      <Field id="pp-resin" label="Resin type">
        <Input id="pp-resin" value={resinType} onChange={(e) => setResinType(e.target.value)} disabled={!canManage} maxLength={60} />
      </Field>
      <Field id="pp-colour" label="Colour">
        <Input id="pp-colour" value={colour} onChange={(e) => setColour(e.target.value)} disabled={!canManage} maxLength={60} />
      </Field>
      <Field id="pp-weight" label="Nominal weight (g)">
        <Input id="pp-weight" type="number" min="0" step="0.001" value={nominalWeightGrams} onChange={(e) => setNominalWeightGrams(e.target.value)} disabled={!canManage} />
      </Field>
      <Field id="pp-capacity" label="Capacity (mL)">
        <Input id="pp-capacity" type="number" min="0" step="0.001" value={capacityMl} onChange={(e) => setCapacityMl(e.target.value)} disabled={!canManage} />
      </Field>
      <Field id="pp-height" label="Height (mm)">
        <Input id="pp-height" type="number" min="0" step="0.01" value={heightMm} onChange={(e) => setHeightMm(e.target.value)} disabled={!canManage} />
      </Field>
      <Field id="pp-diameter" label="Diameter (mm)">
        <Input id="pp-diameter" type="number" min="0" step="0.01" value={diameterMm} onChange={(e) => setDiameterMm(e.target.value)} disabled={!canManage} />
      </Field>
      <Field id="pp-neck" label="Neck finish">
        <Input id="pp-neck" value={neckFinish} onChange={(e) => setNeckFinish(e.target.value)} disabled={!canManage} maxLength={60} />
      </Field>
      <div className="sm:col-span-2">
        <Field id="pp-closure" label="Closure / cap compatibility notes">
          <Textarea id="pp-closure" rows={2} value={closureCompatibilityNotes} onChange={(e) => setClosureCompatibilityNotes(e.target.value)} disabled={!canManage} maxLength={500} />
        </Field>
      </div>
      {canManage ? (
        <div className="sm:col-span-2">
          <SubmitButton pending={sub.pending} pendingLabel="Saving…">Save product spec</SubmitButton>
        </div>
      ) : null}
    </form>
  );
}
