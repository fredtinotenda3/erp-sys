import { AuthCard } from "../../components/features/auth/auth-card";
import { ResetPasswordForm } from "../../components/features/auth/reset-password-form";

export const metadata = { title: "Choose a new password · Operis", referrer: "no-referrer" };

// The token arrives in the query string of the emailed link. `referrer: no-referrer` stops it leaking
// to any third-party resource the page might load.
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  return (
    <AuthCard title="Choose a new password">
      <ResetPasswordForm token={token} />
    </AuthCard>
  );
}
