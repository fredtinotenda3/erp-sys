import { NextRequest, NextResponse } from "next/server";
import { getSupplierById, updateSupplier } from "../../../../../src/server/modules/suppliers/supplier-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const supplier = await getSupplierById(session, id);
    return NextResponse.json({ data: supplier });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const supplier = await updateSupplier(session, id, body);
    return NextResponse.json({ data: supplier });
  } catch (err) {
    return errorResponse(err);
  }
}
