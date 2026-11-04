import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSupplier, listSuppliers, SUPPLIER_STATUS_VALUES } from "../../../../src/server/modules/suppliers/supplier-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";
import { ValidationError } from "../../../../src/server/shared/errors";

// Same rule as customers/route.ts: query-string filters get zod validation
// too, never a bare `as SupplierStatus` cast on unvalidated input.
const listSuppliersQuerySchema = z.object({
  status: z.enum(SUPPLIER_STATUS_VALUES).optional(),
  search: z.string().trim().max(200).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const params = req.nextUrl.searchParams;
    const parsed = listSuppliersQuerySchema.safeParse({
      status: params.get("status") ?? undefined,
      search: params.get("search") ?? undefined,
    });
    if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.issues);

    const suppliers = await listSuppliers(session, parsed.data);
    return NextResponse.json({ data: suppliers });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    const supplier = await createSupplier(session, body);
    return NextResponse.json({ data: supplier }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
