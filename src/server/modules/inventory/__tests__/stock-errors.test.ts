import { describe, it, expect } from "vitest";
import { isBalanceCreationRace, mapStockTriggerError } from "../stock-errors";
import { ConflictError } from "../../../shared/errors";

describe("mapStockTriggerError", () => {
  it("maps the negative-stock trigger message to a ConflictError", () => {
    const e = mapStockTriggerError(new Error("movement would take item x in warehouse y negative (...): negative stock is blocked"));
    expect(e).toBeInstanceOf(ConflictError);
  });
  it("maps no-cost-basis and currency-mix failures to ConflictError", () => {
    expect(mapStockTriggerError(new Error("cannot consume item a from warehouse b: no cost basis exists yet (no prior receipt recorded)"))).toBeInstanceOf(ConflictError);
    expect(mapStockTriggerError(new Error("a USD receipt cannot be averaged into it — convert"))).toBeInstanceOf(ConflictError);
  });
  it("leaves unrelated errors untouched", () => {
    const original = new Error("connection reset");
    expect(mapStockTriggerError(original)).toBe(original);
  });
  it("recognises the first-balance-row creation race only", () => {
    expect(isBalanceCreationRace(new Error('duplicate key value violates unique constraint "stock_balance_pkey"'))).toBe(true);
    expect(isBalanceCreationRace(new Error('duplicate key value violates unique constraint "stock_movement_org_id_client_request_id_key"'))).toBe(false);
  });
});
