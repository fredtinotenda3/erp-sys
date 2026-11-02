// Generic HTTP/Next.js route-handler helpers. Deliberately has NO
// dependency on server/modules/* — session validation lives in
// modules/iam/session-guard.ts, which depends on this file, not the other
// way around, so this file stays a cross-cutting primitive any module can
// use without a layering cycle.
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { AppError, RateLimitError, ValidationError } from "./errors";

export const SESSION_COOKIE_NAME = "mops_session";

export function setSessionCookie(response: NextResponse, token: string, expiresAt: Date): void {
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

// Maps a thrown error to an HTTP response. AppError subclasses carry their
// own status/code (see shared/errors.ts) and are safe to describe to the
// client verbatim — they are the vocabulary the service layer deliberately
// chose to surface. Anything else is an unexpected failure: it is logged
// server-side with full detail but the client gets a generic 500 with no
// internal detail (stack traces, SQL error text, etc. must never reach a
// client response).
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ValidationError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, issues: err.issues } },
      { status: err.httpStatus },
    );
  }
  if (err instanceof RateLimitError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: err.httpStatus, headers: { "Retry-After": String(err.retryAfterSeconds) } },
    );
  }
  if (err instanceof AppError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.httpStatus });
  }
  console.error("Unhandled error in API route:", err);
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
    { status: 500 },
  );
}

// Client address for rate limiting and session metadata.
//
// Forwarding headers are ordinary request headers: any caller can send them. They are therefore trusted
// ONLY where the deployment guarantees the platform overwrites them, and never otherwise:
//   - Vercel (process.env.VERCEL is set by the platform): x-vercel-forwarded-for, then x-real-ip, both
//     overwritten by Vercel's edge, so a caller cannot choose them.
//   - Anywhere else: only the single header named by TRUSTED_CLIENT_IP_HEADER (for example `x-real-ip`
//     behind nginx that sets it with `proxy_set_header X-Real-IP $remote_addr`, or `cf-connecting-ip`
//     behind Cloudflare), and only if your proxy overwrites it on every request. `x-forwarded-for` is
//     deliberately not accepted as that setting: proxies append to it, so its first entry is caller-chosen.
//   - Neither: no header is trusted and this returns undefined. Per-address limits are then skipped
//     (per-account limits still apply) instead of being keyed on a value the attacker controls.
// The value must be a literal IP address; anything else is discarded rather than stored or hashed.
export function clientIp(headers: Headers): string | undefined {
  const names: string[] = [];
  const configured = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (configured && configured !== "x-forwarded-for") names.push(configured);
  else if (process.env.VERCEL) names.push("x-vercel-forwarded-for", "x-real-ip");

  for (const name of names) {
    const raw = headers.get(name)?.split(",")[0]?.trim();
    if (raw && isIP(raw) !== 0) return raw;
  }
  return undefined;
}
