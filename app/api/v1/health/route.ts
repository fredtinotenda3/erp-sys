import { NextResponse } from "next/server";
import { prisma } from "../../../../src/server/shared/db";

// Liveness/readiness probe for uptime monitors and deploy checks. Unauthenticated by design, so it
// returns nothing but "ok"/"degraded" -- no versions, hostnames, error text or counts.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "degraded" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
