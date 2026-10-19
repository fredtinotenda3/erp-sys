"use client";

import { ErrorState } from "../../components/ui/states";
import { Button } from "../../components/ui/button";

// Error boundary for every authenticated route. Server error details are never
// shown (Next hides them in production); the user gets a plain explanation and
// a retry that re-fetches the route.
export default function RouteError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <ErrorState
      title="This page failed to load"
      message={`Something went wrong while building this page. Try again; if it keeps happening, tell your administrator${error.digest ? ` (reference ${error.digest})` : ""}.`}
      action={<Button onClick={() => retry()}>Try again</Button>}
    />
  );
}
