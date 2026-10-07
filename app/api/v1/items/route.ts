import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createItem, listItems, ITEM_TYPE_VALUES } from "../../../../src/server/modules/catalog/item-service";
import { requireSession } from "../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../src/server/shared/http";
import { ValidationError } from "../../../../src/server/shared/errors";

// Query-string filters get the same "never trust unvalidated input" rule as
// a request body — a bare `as ItemType` cast here would let an arbitrary
// string reach the database query unchecked.
const listItemsQuerySchema = z.object({
  itemType: z.enum(ITEM_TYPE_VALUES).optional(),
  isActive: z.enum(["true", "false"]).optional(),
  search: z.string().trim().max(200).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const params = req.nextUrl.searchParams;
    const parsed = listItemsQuerySchema.safeParse({
      itemType: params.get("itemType") ?? undefined,
      isActive: params.get("isActive") ?? undefined,
      search: params.get("search") ?? undefined,
    });
    if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.issues);

    const items = await listItems(session, {
      itemType: parsed.data.itemType,
      isActive: parsed.data.isActive === undefined ? undefined : parsed.data.isActive === "true",
      search: parsed.data.search,
    });
    return NextResponse.json({ data: items });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const body = await req.json();
    const item = await createItem(session, body);
    return NextResponse.json({ data: item }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
