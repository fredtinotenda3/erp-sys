// Bridges the generic HTTP helpers (shared/http.ts) and this module's
// session logic (session-service.ts) for route handlers. Lives in the IAM
// module, not in shared/, so that shared/ has no dependency on any
// server/modules/* module (see shared/http.ts's header comment).
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "../../shared/http";
import { UnauthorizedError } from "../../shared/errors";
import { validateSessionToken, type AuthenticatedSession } from "./session-service";

export async function requireSession(req: NextRequest): Promise<AuthenticatedSession> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) throw new UnauthorizedError("No session cookie present");

  const session = await validateSessionToken(token);
  if (!session) throw new UnauthorizedError("Session is invalid, expired, or revoked");

  return session;
}
