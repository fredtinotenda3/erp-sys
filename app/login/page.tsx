"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

// KNOWN GAP, flagged rather than silently worked around: session-service.ts
// login() requires {organizationId, email, password} because app_user.email
// is only unique PER ORGANIZATION, not platform-wide (see that file's
// header comment) — the same email can legitimately exist in two unrelated
// orgs, so the client has to know which org it's logging into before
// calling login. There is no "find my organization by name" endpoint and
// Organization.name has no unique constraint in schema.prisma to build one
// against safely yet, so this form asks for the raw organization ID — the
// literal field the API accepts today. That is not a decision I'm making
// on your behalf; it's a placeholder for whichever real flow you pick
// (a login subdomain, a slug field + lookup endpoint, or a server-set
// "last used org" cookie from the bootstrap response). The localStorage
// remember-last-org-id below is a minor, non-security convenience only
// (so a returning user doesn't retype a UUID every time), not a substitute
// for that decision.
const LAST_ORG_ID_KEY = "operis.lastOrganizationId";

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
function readRememberedOrgId(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_ORG_ID_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [organizationId, setOrganizationId] = useState(readRememberedOrgId);
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
        body: JSON.stringify({ organizationId: organizationId.trim(), email: email.trim(), password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as LoginErrorBody | null;
        setError(body?.error?.message ?? "Unable to sign in — please try again.");
        return;
      }

      try {
        window.localStorage.setItem(LAST_ORG_ID_KEY, organizationId.trim());
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
          <Label htmlFor="organizationId">Organization ID</Label>
          <Input
            id="organizationId"
            name="organizationId"
            autoComplete="off"
            required
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
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
