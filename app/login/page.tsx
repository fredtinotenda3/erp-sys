"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

// Users identify their organization with a short login handle (slug), e.g.
// "acme-furniture", not a UUID. The last handle used on this device is
// remembered in localStorage purely as a convenience (never security-relevant).
const LAST_ORG_SLUG_KEY = "operis.lastOrganizationSlug";

interface LoginErrorBody {
  error?: { code?: string; message?: string };
}

// Lazy useState initializer, not a useEffect + setState — the effect
// version renders once with an empty field and then immediately re-renders
// with the remembered value, which both flashes and trips
// react-hooks/set-state-in-effect. A lazy initializer runs once, during the
// first render, so the remembered value (if any) is there from the start.
// It also runs during this client component's server-side render pass,
// where `window` doesn't exist — guarded below, same as the try/catch for
// private-browsing/blocked-storage, so it degrades to an empty field in
// both cases rather than throwing.
function readRememberedOrgSlug(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_ORG_SLUG_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [organizationSlug, setOrganizationSlug] = useState(readRememberedOrgSlug);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationSlug: organizationSlug.trim().toLowerCase(), email: email.trim(), password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as LoginErrorBody | null;
        setError(body?.error?.message ?? "Unable to sign in — please try again.");
        return;
      }

      try {
        window.localStorage.setItem(LAST_ORG_SLUG_KEY, organizationSlug.trim().toLowerCase());
      } catch {
        // Same as above — a failed write here never blocks a successful login.
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Couldn't reach the server — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6 shadow-sm">
        <div className="space-y-1 text-center">
          <h1 className="text-base font-semibold">Operis</h1>
          <p className="text-sm text-muted-foreground">Sign in to your organization</p>
        </div>

        {error ? (
          <p role="alert" className="rounded-md bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {error}
          </p>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="organizationSlug">Organization</Label>
          <Input
            id="organizationSlug"
            name="organizationSlug"
            autoComplete="organization"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="e.g. acme-furniture"
            required
            value={organizationSlug}
            onChange={(e) => setOrganizationSlug(e.target.value)}
            aria-invalid={Boolean(error)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(error)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={Boolean(error)}
          />
        </div>

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
