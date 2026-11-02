// Gate for the one unauthenticated tenant-creation endpoint (POST /api/v1/organizations/bootstrap).
//
//  - In production the endpoint is OFF unless ORG_BOOTSTRAP_TOKEN is set, and then each request must
//    present it as the `x-bootstrap-token` header (compared in constant time). Operators enable it
//    only while onboarding a new organization and unset it afterwards.
//  - Outside production with no token set it stays open, so local development keeps working.
//  - Calls are rate limited per trusted client address (and, with no token configured, in one shared bucket).
import { timingSafeEqual } from "node:crypto";
import { ForbiddenError, NotFoundError, RateLimitError } from "../../shared/errors";
import { clientIp } from "../../shared/http";
import { throttleHit, throttleKey, type Limit } from "./auth-throttle";

export const BOOTSTRAP_LIMIT: Limit = { limit: 5, windowMs: 60 * 60 * 1000 };

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function assertBootstrapAllowed(headers: Headers): Promise<void> {
  const configured = process.env.ORG_BOOTSTRAP_TOKEN;
  const production = process.env.NODE_ENV === "production";

  if (production && !configured) throw new NotFoundError("Resource"); // disabled: indistinguishable from a missing route

  // Per trusted address when we have one. With no trusted address (see clientIp in shared/http.ts) and a
  // token configured, the token itself is the gate and a shared bucket would only let an anonymous caller
  // exhaust it and block the operator; with no token (local development) one shared bucket is fine.
  const ip = clientIp(headers);
  if (ip || !configured) {
    const { count } = await throttleHit(throttleKey("bootstrap-ip", ip ?? "unknown"), BOOTSTRAP_LIMIT);
    if (count > BOOTSTRAP_LIMIT.limit) throw new RateLimitError("Too many attempts. Please try again later.", Math.ceil(BOOTSTRAP_LIMIT.windowMs / 1000));
  }

  if (configured) {
    const presented = headers.get("x-bootstrap-token") ?? "";
    if (!sameSecret(presented, configured)) throw new ForbiddenError("A valid bootstrap token is required");
  }
}
