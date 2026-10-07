import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createCustomer, listCustomers, CUSTOMER_STATUS_VALUES } from "../../../../src/server/modules/customers/customer-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";
import { ValidationError } from "../../../../src/server/shared/errors";

// Same rule as items/route.ts: query-string filters get zod validation too,
// never a bare `as CustomerStatus` cast on unvalidated input.
const listCustomersQuerySchema = z.object({
  status: z.enum(CUSTOMER_STATUS_VALUES).optional(),
  search: z.string().trim().max(200).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const params = req.nextUrl.searchParams;
    const parsed = listCustomersQuerySchema.safeParse({
      status: params.get("status") ?? undefined,
      search: params.get("search") ?? undefined,
    });
    if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.issues);

    const customers = await listCustomers(session, parsed.data);
    return NextResponse.json({ data: customers });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    const customer = await createCustomer(session, body);
    return NextResponse.json({ data: customer }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
