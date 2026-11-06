// Plastics material attributes and product specification (Milestone 6),
// both 1:1 extensions of an existing Item -- not new catalog entities of
// their own. Items are org-scoped only (no branch concept -- same as
// item-service.ts), which is why this file, unlike mould-service.ts, never
// touches assertBranchAccess.
//
// WRITE operations here require the organization to be on the plastics
// profile (industry-profile-service.ts's assertPlasticsProfileActive).
// READ operations do not, for the same historical-integrity reason as
// mould-service.ts's header comment.
import { z } from "zod";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { assertPlasticsProfileActive } from "../industry/industry-profile-service";

// Partial-merge helper for the two upsert functions below: `??` alone
// cannot distinguish "caller omitted this field" (undefined -- keep the
// existing value) from "caller explicitly sent null" (clear it) and from
// "caller sent a real value" (set it) -- it collapses the first two into
// whichever fallback comes first. This keeps all three cases distinct:
// `provided` wins whenever the key was present in the request AT ALL
// (including an explicit null), and only a truly omitted key falls back to
// the row's current value (or null, for a field that was never set).
function merged<T>(provided: T | null | undefined, existingValue: T | null | undefined): T | null {
  return provided !== undefined ? provided : (existingValue ?? null);
}

async function findItemInOrg(session: AuthenticatedSession, itemId: string) {
  const item = await prisma.item.findFirst({ where: { orgId: session.orgId, id: itemId } });
  if (!item) throw new NotFoundError("Item");
  return item;
}

// ----------------------------------------------------------------------------
// Material attributes (raw_material / consumable side)
// ----------------------------------------------------------------------------
const blendComponentSchema = z.object({
  component: z.string().trim().min(1).max(100),
  percentage: z.number().positive().max(100),
});

const materialAttributesSchema = z
  .object({
    polymerGrade: z.string().trim().min(1).max(60).nullable(),
    resinSpec: z.string().trim().min(1).max(200).nullable(),
    colourMasterbatch: z.string().trim().min(1).max(100).nullable(),
    additiveNotes: z.string().trim().min(1).max(500).nullable(),
    recycledContentPct: z.number().min(0).max(100).nullable(),
    supplierMaterialRef: z.string().trim().min(1).max(100).nullable(),
    materialCertificateReference: z.string().trim().min(1).max(500).nullable(),
    // Descriptive only (see schema.prisma's comment) -- not required to sum
    // to 100; the remainder is implicitly whatever base resin isn't listed.
    blendComposition: z.array(blendComponentSchema).max(20).nullable(),
  })
  .partial()
  .strict();

export async function getPlasticsMaterialAttributes(session: AuthenticatedSession, itemId: string) {
  assertCapability(session.role, "item:read");
  await findItemInOrg(session, itemId);
  return prisma.plasticsMaterialAttributes.findFirst({ where: { orgId: session.orgId, itemId } });
}

export async function setPlasticsMaterialAttributes(session: AuthenticatedSession, itemId: string, input: unknown) {
  assertCapability(session.role, "plastics_spec:manage");
  await assertPlasticsProfileActive(session);
  const parsed = materialAttributesSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid plastics material attributes payload", parsed.error.issues);
  const d = parsed.data;

  const item = await findItemInOrg(session, itemId);
  if (item.itemType !== "raw_material" && item.itemType !== "consumable") {
    throw new ValidationError("Plastics material attributes only apply to raw_material or consumable items");
  }
  if (d.blendComposition) {
    const total = d.blendComposition.reduce((sum, c) => sum + c.percentage, 0);
    if (total > 100.01) throw new ValidationError("blendComposition percentages cannot sum to more than 100%");
  }

  const existing = await prisma.plasticsMaterialAttributes.findFirst({ where: { orgId: session.orgId, itemId } });
  // Partial-merge, not full-replace (mirrors setPlasticsProductSpec below):
  // an omitted key keeps its existing value, an explicit null clears it,
  // and a provided value sets it -- see merged()'s own comment. This
  // matters in practice: the UI form (plastics-spec-form.tsx's
  // PlasticsMaterialAttributesForm) has no input for blendComposition at
  // all, so treating an omitted key as "wipe to null" would silently
  // destroy any blend-composition data set through a direct API call the
  // instant a user saved an unrelated field (e.g. fixing a polymerGrade
  // typo) through that form.
  const data = {
    orgId: session.orgId,
    itemId,
    polymerGrade: merged(d.polymerGrade, existing?.polymerGrade),
    resinSpec: merged(d.resinSpec, existing?.resinSpec),
    colourMasterbatch: merged(d.colourMasterbatch, existing?.colourMasterbatch),
    additiveNotes: merged(d.additiveNotes, existing?.additiveNotes),
    // existing.recycledContentPct comes back as a Prisma Decimal, not a
    // plain number -- converted before merged() so its generic unifies
    // with d.recycledContentPct's type instead of a type error.
    recycledContentPct: merged(d.recycledContentPct, existing?.recycledContentPct?.toNumber() ?? null),
    supplierMaterialRef: merged(d.supplierMaterialRef, existing?.supplierMaterialRef),
    materialCertificateReference: merged(d.materialCertificateReference, existing?.materialCertificateReference),
  } as Record<string, unknown>;

  // blendComposition is handled separately from the scalar fields above, and
  // deliberately never via the Prisma.DbNull/Prisma.JsonNull sentinels the
  // previous version of this function used. CONFIRMED BY ACTUAL RUNTIME
  // FAILURE (not just reasoning about the type docs): against this
  // project's real Prisma 7 + @prisma/adapter-pg configuration,
  // `Prisma.DbNull` did not reach the database as real SQL NULL -- it was
  // stored as a JSON null, which fails this column's own CHECK constraint
  // (plastics_material_attributes_blend_is_array: "blend_composition IS
  // NULL OR jsonb_typeof(blend_composition) = 'array'") on *every*
  // create/update with no blend composition supplied, which is the common
  // case. The fix below never sends the sentinel at all:
  //   - caller omitted the key entirely (d.blendComposition === undefined):
  //     don't put `blendComposition` in `data` at all. On create, an absent
  //     key leaves the column to its table default (no @default on this
  //     column, so plain SQL NULL -- satisfies the constraint's first
  //     branch). On update, an absent key leaves the column untouched,
  //     which is the intended "omitted key keeps existing value" semantic.
  //   - caller explicitly provided a real array: set `blendComposition` to
  //     that plain array. This is ordinary JSON serialization of a real
  //     value, not a null sentinel, and is unaffected by the bug above.
  //   - caller explicitly provided `null` (an explicit clear request) on an
  //     UPDATE of a row that currently has a non-null value: this is the
  //     one case that must force the column to real SQL NULL. Rather than
  //     trust any Prisma null sentinel again, this is done with a raw,
  //     parameterized UPDATE in the same transaction, which talks to
  //     Postgres directly and has no sentinel-translation step to get wrong.
  const explicitClear = d.blendComposition === null && !!existing?.blendComposition;
  if (Array.isArray(d.blendComposition)) {
    data.blendComposition = d.blendComposition;
  }
  // (If d.blendComposition is undefined, or an explicit null with nothing
  // to clear, `data` simply never gets a blendComposition key -- correct
  // for both create and update, per the reasoning above.)

  return prisma.$transaction(async (tx) => {
    const row = existing
      ? await tx.plasticsMaterialAttributes.update({ where: { id: existing.id }, data })
      : await tx.plasticsMaterialAttributes.create({ data: data as Parameters<typeof tx.plasticsMaterialAttributes.create>[0]["data"] });
    if (explicitClear) {
      await tx.$executeRaw`UPDATE plastics_material_attributes SET blend_composition = NULL WHERE id = ${row.id}::uuid`;
    }
    await recordAudit(tx, {
      orgId: session.orgId,
      actorUserId: session.userId,
      entityType: "plastics_material_attributes",
      entityId: row.id,
      action: existing ? "update" : "create",
      beforeValue: existing ? { polymerGrade: existing.polymerGrade, resinSpec: existing.resinSpec } : undefined,
      afterValue: { itemId, polymerGrade: data.polymerGrade, resinSpec: data.resinSpec },
    });
    return explicitClear ? { ...row, blendComposition: null } : row;
  });
}

// ----------------------------------------------------------------------------
// Product spec (finished_good / wip side)
// ----------------------------------------------------------------------------
const productSpecSchema = z
  .object({
    productType: z.string().trim().min(1).max(60),
    resinType: z.string().trim().min(1).max(60).nullable(),
    colour: z.string().trim().min(1).max(60).nullable(),
    nominalWeightGrams: z.number().positive().max(100_000).nullable(),
    capacityMl: z.number().positive().max(1_000_000).nullable(),
    heightMm: z.number().positive().max(10_000).nullable(),
    diameterMm: z.number().positive().max(10_000).nullable(),
    neckFinish: z.string().trim().min(1).max(60).nullable(),
    closureCompatibilityNotes: z.string().trim().min(1).max(500).nullable(),
    // Display/reference only (see schema.prisma's comment) -- never read by
    // any calculation in this delivery.
    otherAttributes: z.record(z.string(), z.string().max(500)).nullable(),
  })
  .partial()
  .strict()
  .refine((d) => d.productType !== undefined || Object.keys(d).length === 0, "productType is required when creating a spec");

export async function getPlasticsProductSpec(session: AuthenticatedSession, itemId: string) {
  assertCapability(session.role, "item:read");
  await findItemInOrg(session, itemId);
  return prisma.plasticsProductSpec.findFirst({ where: { orgId: session.orgId, itemId } });
}

export async function setPlasticsProductSpec(session: AuthenticatedSession, itemId: string, input: unknown) {
  assertCapability(session.role, "plastics_spec:manage");
  await assertPlasticsProfileActive(session);
  const parsed = productSpecSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid plastics product spec payload", parsed.error.issues);
  const d = parsed.data;

  const item = await findItemInOrg(session, itemId);
  if (item.itemType !== "finished_good" && item.itemType !== "wip") {
    throw new ValidationError("Plastics product spec only applies to finished_good or wip items");
  }

  const existing = await prisma.plasticsProductSpec.findFirst({ where: { orgId: session.orgId, itemId } });
  if (!existing && d.productType === undefined) throw new ValidationError("productType is required when creating a spec");

  // Same merged() partial-merge discipline as setPlasticsMaterialAttributes
  // above -- an omitted key keeps its existing value, an explicit null
  // clears it, and a provided value sets it. productType is the one
  // required field and is handled separately (never nulled; the `!existing
  // && d.productType === undefined` guard above already rejects creating a
  // spec without it, and merged() would otherwise happily "clear" it to
  // null on an update that omits it).
  const data = {
    orgId: session.orgId,
    itemId,
    productType: d.productType ?? existing?.productType,
    resinType: merged(d.resinType, existing?.resinType),
    colour: merged(d.colour, existing?.colour),
    nominalWeightGrams: merged(d.nominalWeightGrams, existing?.nominalWeightGrams?.toNumber() ?? null),
    capacityMl: merged(d.capacityMl, existing?.capacityMl?.toNumber() ?? null),
    heightMm: merged(d.heightMm, existing?.heightMm?.toNumber() ?? null),
    diameterMm: merged(d.diameterMm, existing?.diameterMm?.toNumber() ?? null),
    neckFinish: merged(d.neckFinish, existing?.neckFinish),
    closureCompatibilityNotes: merged(d.closureCompatibilityNotes, existing?.closureCompatibilityNotes),
  } as { productType: string } & Record<string, unknown>;

  // otherAttributes is also a nullable Json column (no CHECK constraint on
  // this one, unlike blendComposition above, but the same underlying Prisma
  // 7 + @prisma/adapter-pg null-sentinel risk applies in principle -- see
  // setPlasticsMaterialAttributes's comment on blendComposition for the
  // confirmed failure mode). Applying the identical, proven-safe pattern
  // here pre-emptively, rather than waiting to find out the hard way a few
  // seconds into seeding every product's spec: omit the key entirely unless
  // there's a real object to set; force an explicit clear with raw SQL
  // rather than any null sentinel.
  const explicitClearOtherAttributes = d.otherAttributes === null && !!existing?.otherAttributes;
  if (d.otherAttributes && typeof d.otherAttributes === "object") {
    data.otherAttributes = d.otherAttributes;
  }

  return prisma.$transaction(async (tx) => {
    const row = existing
      ? await tx.plasticsProductSpec.update({ where: { id: existing.id }, data })
      : await tx.plasticsProductSpec.create({ data: data as Parameters<typeof tx.plasticsProductSpec.create>[0]["data"] });
    if (explicitClearOtherAttributes) {
      await tx.$executeRaw`UPDATE plastics_product_spec SET other_attributes = NULL WHERE id = ${row.id}::uuid`;
    }
    await recordAudit(tx, {
      orgId: session.orgId,
      actorUserId: session.userId,
      entityType: "plastics_product_spec",
      entityId: row.id,
      action: existing ? "update" : "create",
      beforeValue: existing ? { productType: existing.productType, resinType: existing.resinType } : undefined,
      afterValue: { itemId, productType: data.productType, resinType: data.resinType },
    });
    return explicitClearOtherAttributes ? { ...row, otherAttributes: null } : row;
  });
}