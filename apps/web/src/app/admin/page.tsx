/**
 * /admin (§20.3/§20.5) — admin-only: the verified-reviewer grant form and the
 * open-reports moderation queue. `proxy.ts` already gates this route behind
 * sign-in; a non-admin signed-in viewer is redirected to `/` here (the route
 * matcher only checks "signed in", not role — `requireAdmin` is the actual
 * gate on every admin API call, this is just the page-level UX).
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/api/auth";
import { listOpenReports } from "@/lib/repo/reports";
import { AdminClient } from "@/components/admin/AdminClient";

export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Admin — Heimdall",
};

export default async function AdminPage() {
  const viewer = await getViewer();
  if (!viewer) {
    redirect("/sign-in");
  }
  if (viewer.role !== "admin") {
    redirect("/");
  }

  const page = await listOpenReports();
  return <AdminClient initialReports={page.reports} initialNextCursor={page.nextCursor} />;
}
