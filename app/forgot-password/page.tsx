import { AuthCard } from "../../components/features/auth/auth-card";
import { ForgotPasswordForm } from "../../components/features/auth/forgot-password-form";

export const metadata = { title: "Reset your password · Operis" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Reset your password" subtitle="We'll email a one-time link if the account exists">
      <ForgotPasswordForm />
    </AuthCard>
  );
}
