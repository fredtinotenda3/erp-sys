"use client";

import { useState, type FormEvent } from "react";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";

export function ChangePasswordForm() {
  const sub = useSubmission();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [local, setLocal] = useState<Record<string, string>>({});
  const [done, setDone] = useState<number | null>(null);
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const p: Record<string, string> = {};
    if (!current) p.currentPassword = "Enter your current password.";
    if (next.length < 12) p.newPassword = "Use at least 12 characters.";
    else if (next !== confirm) p.confirm = "The two passwords don't match.";
    setLocal(p);
    if (Object.keys(p).length) return sub.fail("Fix the highlighted fields and try again.");
    const r = await sub.run(() => apiRequest<{ otherSessionsRevoked: number }>("/api/v1/auth/password/change", { method: "POST", body: { currentPassword: current, newPassword: next } }));
    if (r?.ok) {
      setDone(r.data.otherSessionsRevoked);
      setCurrent(""); setNext(""); setConfirm("");
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-md space-y-4">
      <FormError message={sub.error} />
      {done !== null ? <p role="status" className="rounded-md bg-status-success-bg px-3 py-2 text-sm text-status-success">Password changed.{done > 0 ? ` ${done} other session${done === 1 ? " was" : "s were"} signed out.` : ""}</p> : null}
      <Field id="currentPassword" label="Current password" required error={errors.currentPassword}><Input id="currentPassword" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field id="newPassword" label="New password" required error={errors.newPassword} hint="At least 12 characters."><Input id="newPassword" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      <Field id="confirm" label="Confirm new password" required error={errors.confirm}><Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      <SubmitButton pending={sub.pending} pendingLabel="Saving…">Change password</SubmitButton>
    </form>
  );
}
