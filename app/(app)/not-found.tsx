import Link from "next/link";

import { EmptyState } from "../../components/ui/states";
import { buttonVariants } from "../../components/ui/button";

export default function NotFound() {
  return (
    <EmptyState
      title="We couldn't find that record"
      action={
        <Link href="/dashboard" className={buttonVariants({ variant: "outline" })}>
          Back to Command Centre
        </Link>
      }
    >
      It may not exist, or it may belong to a branch you don&apos;t have access to.
    </EmptyState>
  );
}
