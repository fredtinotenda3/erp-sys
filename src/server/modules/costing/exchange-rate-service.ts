// Exchange rates. Append-only (DB immutability trigger): a correction is a new
// row, and "the rate" is the latest row for the pair, so history is never
// rewritten. Rates are ORGANIZATION-scoped: another tenant's finance team can
// never change your figures.
//
// Convention: rate = how many units of the QUOTE currency one unit of the
// BASE currency buys. amountInQuote = amountInBase x rate. Only the exact
// stored pair is returned -- an inverse is never silently derived, because a
// derived rate has no row to cite as its source.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

const SOURCES = ["RBZ_OFFICIAL", "MARKET", "MANUAL"] as const;
export type RateSourceValue = (typeof SOURCES)[number];

const currency = z.string().trim().toUpperCase().length(3);

const recordSchema = z
  .object({
    baseCurrency: currency,
    quoteCurrency: currency,
    rate: z
      .number()
      .finite()
      .positive()
      .max(1_000_000_000)
      .refine((n) => Math.abs(n * 1e8 - Math.round(n * 1e8)) < 1e-3, "rate supports at most 8 decimal places"),
    asOfDate: z.coerce.date(),
    source: z.enum(SOURCES),
  })
  .superRefine((d, ctx) => {
    if (d.baseCurrency === d.quoteCurrency) {
      ctx.addIssue({ code: "custom", message: "baseCurrency and quoteCurrency must differ", path: ["quoteCurrency"] });
    }
    if (d.asOfDate.getTime() > Date.now() + 24 * 3600_000) {
      ctx.addIssue({ code: "custom", message: "asOfDate cannot be in the future", path: ["asOfDate"] });
    }
  });

export async function recordExchangeRate(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "exchange_rate:create");
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid exchange rate payload", parsed.error.issues);
  const d = parsed.data;

  const found = await prisma.currency.findMany({ where: { code: { in: [d.baseCurrency, d.quoteCurrency] } } });
  if (found.length !== 2) throw new ValidationError("Unknown currency code in baseCurrency/quoteCurrency");

  return prisma.$transaction(async (tx) => {
    const row = await tx.exchangeRate.create({
      data: {
        orgId: session.orgId,
        baseCurrency: d.baseCurrency,
        quoteCurrency: d.quoteCurrency,
        rate: new Prisma.Decimal(d.rate),
        asOfDate: d.asOfDate,
        source: d.source,
        recordedById: session.userId,
      },
    });
    await recordAudit(tx, {
      orgId: session.orgId,
      actorUserId: session.userId,
      entityType: "exchange_rate",
      entityId: row.id,
      action: "create",
      afterValue: {
        baseCurrency: d.baseCurrency,
        quoteCurrency: d.quoteCurrency,
        rate: String(d.rate),
        asOfDate: d.asOfDate.toISOString().slice(0, 10),
        source: d.source,
      },
    });
    return row;
  });
}

export interface RateLookup {
  baseCurrency: string;
  quoteCurrency: string;
  source?: RateSourceValue;
}

// Internal: no capability check (callers - cost conversion - have their own).
export async function findLatestRate(orgId: string, q: RateLookup) {
  return prisma.exchangeRate.findFirst({
    where: {
      orgId,
      baseCurrency: q.baseCurrency,
      quoteCurrency: q.quoteCurrency,
      ...(q.source ? { source: q.source } : {}),
    },
    orderBy: [{ asOfDate: "desc" }, { recordedAt: "desc" }],
  });
}

const lookupSchema = z.object({
  baseCurrency: currency,
  quoteCurrency: currency,
  source: z.enum(SOURCES).optional(),
});

export async function getLatestExchangeRate(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "exchange_rate:read");
  const parsed = lookupSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid exchange rate query", parsed.error.issues);
  const row = await findLatestRate(session.orgId, parsed.data);
  if (!row) throw new NotFoundError("Exchange rate");
  return row;
}

export async function listExchangeRates(session: AuthenticatedSession, input: unknown = {}) {
  assertCapability(session.role, "exchange_rate:read");
  const parsed = lookupSchema.partial().safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid exchange rate query", parsed.error.issues);
  return prisma.exchangeRate.findMany({
    where: {
      orgId: session.orgId,
      ...(parsed.data.baseCurrency ? { baseCurrency: parsed.data.baseCurrency } : {}),
      ...(parsed.data.quoteCurrency ? { quoteCurrency: parsed.data.quoteCurrency } : {}),
      ...(parsed.data.source ? { source: parsed.data.source } : {}),
    },
    orderBy: [{ asOfDate: "desc" }, { recordedAt: "desc" }],
    take: 200,
  });
}
