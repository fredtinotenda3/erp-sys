"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import type { IndustryProfileRegistryEntry } from "@/lib/api-types";

interface Props {
  profiles: IndustryProfileRegistryEntry[];
  current: { industryProfile: string; enabledModules: string[] };
}

// Changing the profile is a controlled administrative operation (mandate
// §7) -- deliberately no "apply immediately on select" UX; the admin picks
// a profile, sees what it does and doesn't support (including an explicit
// "no modules implemented yet" notice for the five architecturally-
// supported-only profiles), chooses which of its modules to turn on, and
// submits once. A short written reason is required, the same discipline
// as every other business-impacting change in this codebase that calls
// recordAudit with one.
export function IndustryProfileForm({ profiles, current }: Props) {
  const router = useRouter();
  const sub = useSubmission();
  const [profileKey, setProfileKey] = useState(current.industryProfile);
  const [modules, setModules] = useState<string[]>(current.enabledModules);
  const [reason, setReason] = useState("");

  const selected = profiles.find((p) => p.key === profileKey) ?? profiles[0];
  const changingProfile = profileKey !== current.industryProfile;

  function toggleModule(key: string) {
    setModules((prev) => (prev.includes(key) ? prev.filter((m) => m !== key) : [...prev, key]));
  }

  function onSelectProfile(key: string) {
    setProfileKey(key);
    // Switching profile clears module selection -- a module key only ever
    // means something under the profile it belongs to; carrying modules
    // across a profile switch would silently misrepresent what's enabled.
    setModules([]);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (changingProfile && reason.trim().length === 0) {
      return sub.fail("Give a short reason for changing the manufacturing profile.");
    }
    const r = await sub.run(() =>
      apiRequest("/api/v1/organization/industry-profile", {
        method: "PATCH",
        body: { industryProfile: profileKey, enabledModules: modules, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      }),
    );
    if (r?.ok) { setReason(""); router.refresh(); }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-2xl space-y-4">
      <FormError message={sub.error} />
      <Field id="profile" label="Manufacturing profile" required>
        <Select id="profile" value={profileKey} onChange={(e) => onSelectProfile(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.key} value={p.key}>{p.label}{p.isImplemented ? "" : " (no modules implemented yet)"}</option>
          ))}
        </Select>
      </Field>
      <p className="text-sm text-muted-foreground">{selected.description}</p>

      {selected.availableModules.length > 0 ? (
        <Card className="space-y-2 p-4">
          <p className="text-sm font-medium">Optional modules</p>
          {selected.availableModules.map((m) => (
            <label key={m.key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={modules.includes(m.key)}
                onChange={() => toggleModule(m.key)}
              />
              <span>
                <span className="font-medium">{m.label}</span>
                <span className="block text-muted-foreground">{m.description}</span>
              </span>
            </label>
          ))}
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          This profile has no optional modules implemented yet. Selecting it changes the organization&apos;s profile
          but does not turn on any industry-specific behaviour.
        </p>
      )}

      {changingProfile && (
        <Field id="reason" label="Reason for this change" required error={sub.fieldErrors.reason}>
          <textarea
            id="reason"
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
        </Field>
      )}

      <div className="flex gap-2">
        <SubmitButton pending={sub.pending} pendingLabel="Saving…">Save</SubmitButton>
        <Button
          type="button"
          variant="outline"
          disabled={sub.pending}
          onClick={() => { setProfileKey(current.industryProfile); setModules(current.enabledModules); setReason(""); }}
        >
          Reset
        </Button>
      </div>
    </form>
  );
}
