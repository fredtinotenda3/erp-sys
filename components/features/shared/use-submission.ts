"use client";

import { useRef, useState } from "react";

import { describeError, fieldErrorsFromIssues, outcomeOf, type ApiResult } from "@/lib/api-client";
import type { IdempotentRequest } from "@/lib/idempotency";

// One in-flight request at a time per form. The ref guard closes the gap a
// `disabled` button leaves (a second click or Enter press landing before React
// re-renders), which is what actually prevents accidental duplicate submits.
export function useSubmission() {
  const inflight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function run<T>(
    call: () => Promise<ApiResult<T>>,
    opts: { idempotency?: IdempotentRequest; visibleFields?: readonly string[] } = {},
  ): Promise<ApiResult<T> | null> {
    if (inflight.current) return null;
    inflight.current = true;
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await call();
      opts.idempotency?.settle(outcomeOf(result));
      if (!result.ok) {
        setFieldErrors(fieldErrorsFromIssues(result.error.issues));
        setError(describeError(result.error, opts.visibleFields));
      }
      return result;
    } finally {
      inflight.current = false;
      setPending(false);
    }
  }

  function fail(message: string, fields: Record<string, string> = {}) {
    setError(message);
    setFieldErrors(fields);
  }

  function clear() {
    setError(null);
    setFieldErrors({});
  }

  return { pending, error, fieldErrors, run, fail, clear };
}
