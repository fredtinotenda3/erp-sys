// Database-backed fixed-window counters for login and password-reset throttling.
//
// Why the database and not process memory: the app runs on serverless/multi-instance hosting, where
// an in-memory counter resets on every cold start and is not shared between instances, so it would
// give almost no protection. Why raw SQL: the upsert must be one atomic statement (two concurrent
// attempts must both be counted), which an ORM read-then-write cannot guarantee.
//
// Keys are SHA-256 hashes of "<scope>:<identifier>" so emails and IP addresses are never stored.
import { createHash } from "node:crypto";
import { prisma, type Db } from "../../shared/db";
import { RateLimitError } from "../../shared/errors";

export interface Limit {
  /** Attempts allowed inside the window; the (limit+1)-th is refused. */
  limit: number;
  windowMs: number;
}

export function throttleKey(scope: string, identifier: string): string {
  return createHash("sha256").update(`${scope}:${identifier}`).digest("hex");
}

const iso = (d: Date) => d.toISOString();

/** Counts one attempt and returns the new count inside the current window. Atomic. */
export async function throttleHit(key: string, { windowMs }: Limit, db: Db = prisma, now = new Date()): Promise<{ count: number; windowStart: Date }> {
  const cutoff = new Date(now.getTime() - windowMs);
  const rows = await db.$queryRaw<{ count: number; window_start: Date }[]>`
    INSERT INTO auth_throttle (key, window_start, count)
    VALUES (${key}, ${iso(now)}::timestamptz AT TIME ZONE 'UTC', 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN auth_throttle.window_start <= ${iso(cutoff)}::timestamptz AT TIME ZONE 'UTC' THEN 1 ELSE auth_throttle.count + 1 END,
      window_start = CASE WHEN auth_throttle.window_start <= ${iso(cutoff)}::timestamptz AT TIME ZONE 'UTC' THEN ${iso(now)}::timestamptz AT TIME ZONE 'UTC' ELSE auth_throttle.window_start END
    RETURNING count, window_start`;
  return { count: rows[0]!.count, windowStart: rows[0]!.window_start };
}

/** Read-only: seconds until this key may be used again, or 0 if it is not currently limited. */
export async function throttleRetryAfter(key: string, { limit, windowMs }: Limit, db: Db = prisma, now = new Date()): Promise<number> {
  const rows = await db.$queryRaw<{ count: number; window_start: Date }[]>`
    SELECT count, window_start FROM auth_throttle WHERE key = ${key}`;
  const row = rows[0];
  if (!row) return 0;
  // window_start is a UTC timestamp stored without a zone; the driver returns it as a UTC Date.
  const resetAt = new Date(row.window_start).getTime() + windowMs;
  if (resetAt <= now.getTime() || row.count < limit) return 0;
  return Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000));
}

export async function throttleClear(key: string, db: Db = prisma): Promise<void> {
  await db.$executeRaw`DELETE FROM auth_throttle WHERE key = ${key}`;
}

/**
 * Throws RateLimitError if any key is already at its limit. Does not count
 * an attempt. The keys are independent reads (different counters, no
 * dependency between them), so they run concurrently rather than one round
 * trip per key -- same decision (max retry-after across all keys), just not
 * paid for serially on a high-latency connection.
 */
export async function assertNotThrottled(keys: { key: string; rule: Limit }[], db: Db = prisma, now = new Date()): Promise<void> {
  const waits = await Promise.all(keys.map(({ key, rule }) => throttleRetryAfter(key, rule, db, now)));
  const worst = Math.max(0, ...waits);
  if (worst > 0) throw new RateLimitError("Too many attempts. Please try again later.", worst);
}

/** Housekeeping: drops counters whose window has long passed. Safe to run any time. */
export async function purgeExpiredThrottles(olderThanMs = 24 * 60 * 60 * 1000, db: Db = prisma): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  return db.$executeRaw`DELETE FROM auth_throttle WHERE window_start < ${iso(cutoff)}::timestamptz AT TIME ZONE 'UTC'`;
}
