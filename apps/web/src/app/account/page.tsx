/**
 * /account (§20.2) — identity card + "My runs" management. `proxy.ts`
 * already gates this route behind sign-in; no viewer here is a defensive
 * fallback (e.g. a session that expired mid-render), not the normal path.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/api/auth";
import { readUserRecord } from "@/lib/repo/users";
import { listRunsForUser } from "@/lib/repo/runs";
import { AccountClient } from "@/components/account/AccountClient";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Account — Heimdall",
};

export default async function AccountPage() {
  const viewer = await getViewer();
  if (!viewer) {
    redirect("/sign-in");
  }

  const [user, runsPage] = await Promise.all([
    readUserRecord(viewer.userId),
    listRunsForUser(viewer.userId),
  ]);
  if (!user) {
    redirect("/sign-in");
  }

  return <AccountClient user={user} initialRuns={runsPage.runs} initialNextCursor={runsPage.nextCursor} />;
}
