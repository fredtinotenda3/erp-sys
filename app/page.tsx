import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE_NAME } from "../src/server/shared/http";
import { validateSessionToken } from "../src/server/modules/iam/session-service";

// Replaces the create-next-app boilerplate: there is no standalone "home
// page" content in this app's IA (§1.1 starts at Command Centre) — `/` is
// just a redirect to wherever the visitor actually belongs.
export default async function RootPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await validateSessionToken(token) : null;

  redirect(session ? "/dashboard" : "/login");
}
