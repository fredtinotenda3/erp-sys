"use client";

import { useSyncExternalStore } from "react";

import { formatDateTimeLocal, formatDateTimeUtc } from "@/lib/format";

const subscribe = () => () => {};

// Server render and first client render both use deterministic UTC text, so
// there is no hydration mismatch; once hydrated the same <time> element shows
// the viewer's local time. useSyncExternalStore is the supported way to branch
// on "have we hydrated" without an effect.
export function LocalTime({ iso }: { iso: string | null | undefined }) {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  if (!iso) return <span>—</span>;
  return (
    <time dateTime={iso} title={formatDateTimeUtc(iso)} className="whitespace-nowrap tabular-nums">
      {hydrated ? formatDateTimeLocal(iso) : formatDateTimeUtc(iso)}
    </time>
  );
}
