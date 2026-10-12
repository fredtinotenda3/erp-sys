// Translates database-trigger failures from the stock ledger into domain
// errors. The stock_movement BEFORE INSERT trigger is the single enforcement
// point for negative-stock blocking, cost-basis rules and currency mixing
// (it must be: application code can never be trusted to be the only writer).
// This file only gives those failures a proper HTTP-friendly shape.
import { ConflictError } from "../../shared/errors";

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return `${err.message} ${cause instanceof Error ? cause.message : ""}`;
  }
  return String(err);
}

// True when two first-ever movements for the same (item, warehouse) raced to
// create the stock_balance row; the loser should simply retry.
export function isBalanceCreationRace(err: unknown): boolean {
  const m = messageOf(err);
  return /stock_balance/.test(m) && /(duplicate key|unique constraint|P2002)/i.test(m);
}

export function mapStockTriggerError(err: unknown): unknown {
  const m = messageOf(err);
  if (m.includes("negative stock is blocked")) {
    return new ConflictError("Insufficient stock: this movement would take the balance below zero");
  }
  if (m.includes("no cost basis exists yet")) {
    return new ConflictError("This item has no stock or cost history in that warehouse — receive stock before issuing it");
  }
  if (m.includes("cannot be averaged into it")) {
    return new ConflictError(
      "This item's current stock is valued in a different currency. Receive it in the same currency, or use up the existing stock first.",
    );
  }
  if (m.includes("does not match warehouse")) {
    return new ConflictError("The warehouse does not belong to the movement's branch");
  }
  return err;
}
