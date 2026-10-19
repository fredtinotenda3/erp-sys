"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Notice } from "@/components/ui/notice";
import type { Currency } from "@/lib/api-types";

export function CurrencySelect({
  id,
  value,
  onChange,
  currencies,
  invalid,
  describedBy,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  currencies: Currency[];
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined} aria-describedby={describedBy} disabled={disabled}>
      <option value="">Currency…</option>
      {currencies.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code} — {c.name}
        </option>
      ))}
    </Select>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? <Notice tone="danger">{message}</Notice> : null;
}

export function SubmitButton({
  pending,
  children,
  pendingLabel = "Saving…",
  variant = "primary",
  disabled,
  form,
}: {
  pending: boolean;
  /** id of the <form> to submit, for buttons rendered outside it (e.g. a dialog footer). */
  form?: string;
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "destructive";
  disabled?: boolean;
}) {
  return (
    <Button type="submit" form={form} variant={variant} disabled={pending || disabled} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
