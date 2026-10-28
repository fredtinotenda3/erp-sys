import { NextRequest, NextResponse } from "next/server";
import { getCustomerById, updateCustomer } from "../../../../../src/server/modules/customers/customer-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const customer = await getCustomerById(session, id);
    return NextResponse.json({ data: customer });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const customer = await updateCustomer(session, id, body);
    return NextResponse.json({ data: customer });
  } catch (err) {
    return errorResponse(err);
  }
}
