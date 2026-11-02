"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/features/shared/form-bits";

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (password.length < 12) return setError("Use at least 12 characters.");
    if (password !== confirm) return setError("The two passwords don't match.");
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/v1/auth/password-reset/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, newPassword: password }) });
      if (res.ok) setDone(true);
      else setError(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "Something went wrong. Please try again.");
    } catch {
      setError("Couldn't reach the server — check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  if (!token) return <p className="text-sm">This reset link is incomplete. <Link href="/forgot-password" className="text-primary hover:underline">Request a new one</Link>.</p>;
  if (done) {
    return (
      <div className="space-y-4 text-sm">
        <p role="status">Your password was updated and all other sessions were signed out.</p>
        <Link href="/login" className="text-primary underline-offset-2 hover:underline">Sign in</Link>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError message={error} />
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      <Button type="submit" disabled={pending} className="w-full">{pending ? "Saving…" : "Set new password"}</Button>
    </form>
  );
}
