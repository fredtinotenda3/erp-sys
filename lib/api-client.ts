// Thin browser-side wrapper over the existing /api/v1 endpoints. It does not
// invent contracts: it only normalises the documented envelope
//   success: { data, balance?, replayed? }      error: { error: { code, message, issues? } }
// and classifies the outcome so callers can follow the idempotency rules.
import type { Outcome } from "./idempotency";

export interface ApiIssue {
  path?: (string | number)[];
  message?: string;
}

export interface ApiError {
  code: string;
  message: string;
  issues?: ApiIssue[];
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T; balance?: unknown; replayed: boolean }
  | { ok: false; status: number; error: ApiError; network: boolean };

export async function apiRequest<T = unknown>(
  path: string,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
      cache: "no-store",
    });
  } catch {
    return {
      ok: false,
      status: 0,
      network: true,
      error: { code: "NETWORK", message: "Couldn't reach the server. Check your connection and try again." },
    };
  }

  const json = (await response.json().catch(() => null)) as
    | { data?: T; balance?: unknown; replayed?: boolean; error?: ApiError }
    | null;

  if (response.status === 401 && typeof window !== "undefined") {
    // Hard navigation on purpose: an expired session should drop all client state, not soft-route.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      network: false,
      error: json?.error ?? { code: "HTTP_ERROR", message: `The server returned an unexpected response (${response.status}).` },
    };
  }
  return { ok: true, status: response.status, data: json?.data as T, balance: json?.balance, replayed: json?.replayed === true };
}

/** Maps a result to the idempotency outcome: only a definite 4xx means "nothing was written". */
export function outcomeOf(result: ApiResult<unknown>): Outcome {
  if (result.ok) return "success";
  if (result.network || result.status >= 500) return "unknown";
  return "rejected";
}

/** First message per field, keyed by dotted path ("lines.0.quantity"). */
export function fieldErrorsFromIssues(issues: ApiIssue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues ?? []) {
    const key = (issue.path ?? []).join(".");
    if (key && issue.message && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/** A readable one-line summary when issues can't be attached to a visible field. */
export function describeError(error: ApiError, visibleFields: readonly string[] = []): string {
  const unattached = (error.issues ?? []).filter((i) => !visibleFields.includes((i.path ?? []).join(".")));
  if (unattached.length === 0 || error.code !== "VALIDATION_ERROR") return error.message;
  const detail = unattached
    .map((i) => ((i.path ?? []).length ? `${(i.path ?? []).join(".")}: ${i.message}` : i.message))
    .filter(Boolean)
    .join("; ");
  return detail ? `${error.message} — ${detail}` : error.message;
}
