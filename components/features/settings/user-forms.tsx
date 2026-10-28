"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, describedBy } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { FormError, SubmitButton } from "@/components/features/shared/form-bits";
import { useSubmission } from "@/components/features/shared/use-submission";
import { apiRequest } from "@/lib/api-client";
import { humanize } from "@/lib/format";
import { requireText } from "@/lib/validate";

type Branch = { id: string; name: string };

export function NewUserForm({ roles, branches }: { roles: string[]; branches: Branch[] }) {
  const router = useRouter();
  const sub = useSubmission();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState(roles.includes("VIEWER") ? "VIEWER" : (roles[0] ?? ""));
  const [password, setPassword] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [local, setLocal] = useState<Record<string, string>>({});
  const errors = { ...sub.fieldErrors, ...local };

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const p: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) p.email = "Enter a valid email address.";
    const n = requireText(fullName, "Full name", { max: 200 });
    if (n) p.fullName = n;
    if (!role) p.role = "Choose a role.";
    if (password.length < 12) p.password = "Use at least 12 characters.";
    setLocal(p);
    if (Object.keys(p).length) return sub.fail("Fix the highlighted fields and try again.");
    const r = await sub.run(() => apiRequest<{ id: string }>("/api/v1/users", { method: "POST", body: { email: email.trim(), fullName: fullName.trim(), role, password, branchIds: role === "OWNER_ADMIN" ? [] : picked } }));
    if (r?.ok) {
      router.push(`/settings/users/${r.data.id}`);
      router.refresh();
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
      <FormError message={sub.error} />
      <Field id="fullName" label="Full name" required error={errors.fullName}><Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={200} /></Field>
      <Field id="email" label="Email" required error={errors.email}><Input id="email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field id="role" label="Role" required error={errors.role} hint="Roles you can't assign aren't listed.">
        <Select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => <option key={r} value={r}>{humanize(r.toLowerCase())}</option>)}
        </Select>
      </Field>
      <Field id="password" label="Temporary password" required error={errors.password} hint="At least 12 characters. Share it securely; it is never shown again.">
        <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={describedBy("password", { error: errors.password, hint: "x" })} />
      </Field>
      {role !== "OWNER_ADMIN" ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Branch access</legend>
          {branches.length === 0 ? <p className="text-sm text-muted-foreground">No branches available to assign.</p> : branches.map((b) => (
            <label key={b.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={picked.includes(b.id)} onChange={(e) => setPicked((ps) => (e.target.checked ? [...ps, b.id] : ps.filter((x) => x !== b.id)))} />
              {b.name}
            </label>
          ))}
        </fieldset>
      ) : <p className="text-sm text-muted-foreground">Owner/admins can work in every branch automatically.</p>}
      <div className="flex gap-2">
        <SubmitButton pending={sub.pending} pendingLabel="Creating…">Create user</SubmitButton>
        <Button type="button" variant="outline" disabled={sub.pending} onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}

export function UserAdminPanel({
  user,
  assignableRoles,
  canChangeRole,
  canDeactivate,
  canGrant,
  canRevoke,
  grantableBranches,
}: {
  user: { id: string; fullName: string; role: string; isActive: boolean; implicitAllBranches: boolean; branchAccess: { branchId: string; name: string }[] };
  assignableRoles: string[];
  canChangeRole: boolean;
  canDeactivate: boolean;
  canGrant: boolean;
  canRevoke: boolean;
  grantableBranches: Branch[];
}) {
  const router = useRouter();
  const roleSub = useSubmission();
  const accessSub = useSubmission();
  const deactSub = useSubmission();
  const [role, setRole] = useState(user.role);
  const [grantId, setGrantId] = useState("");
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const done = () => router.refresh();

  return (
    <div className="space-y-5">
      {canChangeRole && user.isActive ? (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">Role</h2>
          <FormError message={roleSub.error} />
          <div className="flex flex-wrap items-end gap-2">
            <Field id="role" label="Role" className="min-w-56">
              <Select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
                {!assignableRoles.includes(user.role) ? <option value={user.role}>{humanize(user.role.toLowerCase())} (current)</option> : null}
                {assignableRoles.map((r) => <option key={r} value={r}>{humanize(r.toLowerCase())}</option>)}
              </Select>
            </Field>
            <Button disabled={roleSub.pending || role === user.role} onClick={async () => { const r = await roleSub.run(() => apiRequest(`/api/v1/users/${user.id}`, { method: "PATCH", body: { role } })); if (r?.ok) done(); }}>Save role</Button>
          </div>
        </Card>
      ) : null}

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">Branch access</h2>
        <FormError message={accessSub.error} />
        {user.implicitAllBranches ? <p className="text-sm text-muted-foreground">Owner/admins can work in every branch; there is nothing to assign.</p> : (
          <>
            {user.branchAccess.length === 0 ? <p className="text-sm text-muted-foreground">No branch access yet — this user can&apos;t open any branch data.</p> : (
              <ul className="divide-y divide-border text-sm">
                {user.branchAccess.map((b) => (
                  <li key={b.branchId} className="flex items-center justify-between py-2">
                    <span>{b.name}</span>
                    {canRevoke ? <Button size="sm" variant="outline" disabled={accessSub.pending} onClick={async () => { const r = await accessSub.run(() => apiRequest(`/api/v1/users/${user.id}/branch-access?branchId=${b.branchId}`, { method: "DELETE" })); if (r?.ok) done(); }}>Remove</Button> : null}
                  </li>
                ))}
              </ul>
            )}
            {canGrant && grantableBranches.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field id="grant" label="Add a branch" className="min-w-56">
                  <Select id="grant" value={grantId} onChange={(e) => setGrantId(e.target.value)}>
                    <option value="">Choose a branch…</option>
                    {grantableBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>
                </Field>
                <Button disabled={accessSub.pending || !grantId} onClick={async () => { const r = await accessSub.run(() => apiRequest(`/api/v1/users/${user.id}/branch-access`, { method: "POST", body: { branchId: grantId } })); if (r?.ok) { setGrantId(""); done(); } }}>Grant access</Button>
              </div>
            ) : null}
          </>
        )}
      </Card>

      {canDeactivate && user.isActive ? (
        <Card className="space-y-2 p-4">
          <h2 className="text-sm font-semibold">Deactivate account</h2>
          <p className="text-sm text-muted-foreground">The user can no longer sign in and their sessions end. History stays intact. There is no reactivate action yet.</p>
          <Button variant="outline" onClick={() => setConfirmDeactivate(true)}>Deactivate {user.fullName}</Button>
          <Modal open={confirmDeactivate} onClose={() => { if (!deactSub.pending) { setConfirmDeactivate(false); deactSub.clear(); } }} title={`Deactivate ${user.fullName}?`} description="This signs them out immediately and can't be undone from this screen."
            footer={<><Button variant="outline" disabled={deactSub.pending} onClick={() => setConfirmDeactivate(false)}>Keep active</Button><SubmitButton pending={deactSub.pending} pendingLabel="Deactivating…" variant="destructive" form="deactivate-user">Deactivate</SubmitButton></>}>
            <form id="deactivate-user" onSubmit={async (e) => { e.preventDefault(); const r = await deactSub.run(() => apiRequest(`/api/v1/users/${user.id}`, { method: "PATCH", body: { isActive: false } })); if (r?.ok) { setConfirmDeactivate(false); done(); } }}><FormError message={deactSub.error} /></form>
          </Modal>
        </Card>
      ) : null}
    </div>
  );
}
