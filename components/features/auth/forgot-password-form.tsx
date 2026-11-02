"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/features/shared/form-bits";

// Shows the SAME confirmation whether or not the account exists (the server answers identically).
export function ForgotPasswordForm() {
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/v1/auth/password-reset/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationSlug: organizationSlug.trim().toLowerCase(), email: email.trim() }) });
      if (res.status === 202) setDone(true);
      else setError(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? "Something went wrong. Please try again.");
    } catch {
      setError("Couldn't reach the server — check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4 text-sm">
        <p role="status">If that account exists, a reset link has been sent. It stays valid for 30 minutes and can be used once.</p>
        <Link href="/login" className="text-primary underline-offset-2 hover:underline">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError message={error} />
      <div className="space-y-1.5">
        <Label htmlFor="organizationSlug">Organization</Label>
        <Input id="organizationSlug" autoCapitalize="none" spellCheck={false} required value={organizationSlug} onChange={(e) => setOrganizationSlug(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <Button type="submit" disabled={pending} className="w-full">{pending ? "Sending…" : "Send reset link"}</Button>
      <p className="text-center text-sm"><Link href="/login" className="text-primary underline-offset-2 hover:underline">Back to sign in</Link></p>
    </form>
  );
}
