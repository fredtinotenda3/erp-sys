// Generic HTTP/Next.js route-handler helpers. Deliberately has NO
// dependency on server/modules/* — session validation lives in
// modules/iam/session-guard.ts, which depends on this file, not the other
// way around, so this file stays a cross-cutting primitive any module can
// use without a layering cycle.
import { NextResponse } from "next/server";
import { AppError, ValidationError } from "./errors";

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
  if (err instanceof AppError) {
    return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.httpStatus });
  }
  // eslint-disable-next-line no-console
  console.error("Unhandled error in API route:", err);
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } },
    { status: 500 },
  );
}
