"use client";

import { useEffect, useState } from "react";

import { apiRequest } from "@/lib/api-client";
import type { StockBalance } from "@/lib/api-types";

export type OnHand = { state: "idle" } | { state: "loading" } | { state: "ok"; quantity: string } | { state: "error" };

/** Reads the real balance for one item in one warehouse; never guesses or defaults to zero on failure. */
export function useOnHand(itemId: string, warehouseId: string, refreshKey: unknown = null): OnHand {
  const [result, setResult] = useState<{ key: string; value: OnHand } | null>(null);
  const key = `${itemId}|${warehouseId}|${String(refreshKey)}`;
  useEffect(() => {
    if (!itemId || !warehouseId) return;
    const controller = new AbortController();
    void apiRequest<StockBalance[]>(`/api/v1/stock/balances?itemId=${itemId}&warehouseId=${warehouseId}`, { signal: controller.signal }).then((r) => {
      if (controller.signal.aborted) return;
      setResult({ key, value: r.ok ? { state: "ok", quantity: r.data[0]?.quantity ?? "0" } : { state: "error" } });
    });
    return () => controller.abort();
  }, [itemId, warehouseId, key]);
  if (!itemId || !warehouseId) return { state: "idle" };
  return result && result.key === key ? result.value : { state: "loading" };
}
