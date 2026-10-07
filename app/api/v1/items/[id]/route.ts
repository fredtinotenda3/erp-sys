import { NextRequest, NextResponse } from "next/server";
import { getItemById, updateItem } from "../../../../../src/server/modules/catalog/item-service";
import { requireSession } from "../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../src/server/shared/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const item = await getItemById(session, id);
    return NextResponse.json({ data: item });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    const { id } = await params;
    const body = await req.json();
    const item = await updateItem(session, id, body);
    return NextResponse.json({ data: item });
  } catch (err) {
    return errorResponse(err);
  }
}
