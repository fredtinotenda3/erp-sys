import { ChangePasswordForm } from "../../../../components/features/auth/change-password-form";
import { PageHeader } from "../../../../components/ui/page-header";

export const metadata = { title: "Change password · Operis" };

export default function ChangePasswordPage() {
  return (
    <>
      <PageHeader title="Change password" description="You'll stay signed in here; every other device is signed out." />
      <ChangePasswordForm />
    </>
  );
}
