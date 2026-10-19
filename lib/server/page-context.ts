// Server-side context for protected pages. It reuses the EXISTING session
// machinery (cookie -> validateSessionToken -> AuthenticatedSession); it is not
// a second auth system. Every page still calls services that re-check
// capability, org and branch scope -- `can()` here only decides what to render.
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME } from "../../src/server/shared/http";
import { validateSessionToken, type AuthenticatedSession } from "../../src/server/modules/iam/session-service";
import { getCurrentUserDisplay, type CurrentUserDisplay } from "../../src/server/modules/iam/me-service";
import { capabilitiesFor, type Capability } from "../../src/server/shared/authz";
import { AppError } from "../../src/server/shared/errors";

import { BRANCH_COOKIE } from "../branch-cookie";

export interface PageContext {
  session: AuthenticatedSession;
  me: CurrentUserDisplay;
  can: (capability: Capability) => boolean;
  /** UI preference only (cookie), validated against the user's real branches. null = all branches. */
  selectedBranchId: string | null;
  branchName: (id: string | null | undefined) => string;
}

export const getPageContext = cache(async (): Promise<PageContext> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await validateSessionToken(token) : null;
  if (!session) redirect("/login");

  const me = await getCurrentUserDisplay(session);
  const caps = new Set<Capability>(capabilitiesFor(session.role));

  const wanted = cookieStore.get(BRANCH_COOKIE)?.value;
  const selectedBranchId = wanted && me.branches.some((b) => b.id === wanted) ? wanted : null;
  const names = new Map(me.branches.map((b) => [b.id, b.name]));

  return {
    session,
    me,
    can: (c) => caps.has(c),
    selectedBranchId,
    branchName: (id) => (id ? (names.get(id) ?? "Unknown branch") : "All branches"),
  };
});

export type Loaded<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

/**
 * Runs one service call and turns failure into data the page can render
 * (access denied, not found, error) instead of crashing the whole route. The
 * result is JSON-roundtripped so Decimals/Dates become the same strings the
 * HTTP API would send and are safe to hand to Client Components.
 */
export async function load<T>(fn: () => Promise<unknown>): Promise<Loaded<T>> {
  try {
    const value = await fn();
    return { ok: true, data: JSON.parse(JSON.stringify(value ?? null)) as T };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, status: err.httpStatus, message: err.message };
    console.error("Unhandled error while loading page data:", err);
    return { ok: false, status: 500, message: "Something went wrong while loading this data." };
  }
}

/** First value of a search param, trimmed; undefined when empty. */
export function param(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const t = v?.trim();
  return t ? t : undefined;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
