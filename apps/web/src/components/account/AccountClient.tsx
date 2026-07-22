"use client";

/**
 * /account client half (§20.2/§20.4) — identity card, "My runs" (visibility
 * switcher + delete), and account deletion. Matches
 * `design/ui_kits/web/screens.jsx` `AccountPage`. The "Report content"
 * moderation card from the kit is §20.5 — not built yet, deliberately.
 */

import * as React from "react";
import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import { Avatar, Badge, Button, Card, IconButton, Select } from "@heimdall/ui";
import { accountRunsResponseSchema, RUN_VISIBILITY } from "@heimdall/shared";
import type { AccountResponse, OwnedRunListItem, RunVisibility } from "@heimdall/shared";
import { icon } from "@/components/icons";
import { deleteAccount, deleteRun, updateRunVisibility } from "@/lib/api/client";
import { MEDIUM_DATE_FORMATTER, VISIBILITY_LABELS } from "@/lib/format";

const TrashIcon = icon(
  <g>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </g>,
);
const LogOutIcon = icon(
  <g>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5" />
    <path d="M21 12H9" />
  </g>,
);

const VISIBILITY_OPTIONS = [
  RUN_VISIBILITY.private,
  RUN_VISIBILITY.unlisted,
  RUN_VISIBILITY.public,
].map((value) => ({ value, label: VISIBILITY_LABELS[value] }));

export function AccountClient({
  user,
  initialRuns,
  initialNextCursor,
}: {
  user: AccountResponse;
  initialRuns: OwnedRunListItem[];
  initialNextCursor: string | null;
}) {
  const { user: clerkUser } = useUser();
  const { signOut } = useClerk();
  const [runs, setRuns] = React.useState(initialRuns);
  const [nextCursor, setNextCursor] = React.useState(initialNextCursor);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deletingAccount, setDeletingAccount] = React.useState(false);

  async function changeVisibility(id: string, visibility: RunVisibility) {
    setBusyId(id);
    setError(null);
    const result = await updateRunVisibility(id, visibility);
    if (result.ok) {
      setRuns((prev) => prev.map((run) => (run.id === id ? { ...run, visibility } : run)));
    } else {
      setError(`Couldn't update visibility — ${result.message}.`);
    }
    setBusyId(null);
  }

  async function removeRun(id: string) {
    setBusyId(id);
    setError(null);
    const result = await deleteRun(id);
    if (result.ok) {
      setRuns((prev) => prev.filter((run) => run.id !== id));
    } else {
      setError(`Couldn't delete that run — ${result.message}.`);
    }
    setBusyId(null);
  }

  async function removeAccount() {
    setDeletingAccount(true);
    setError(null);
    const result = await deleteAccount();
    if (result.ok) {
      await signOut({ redirectUrl: "/" });
      return;
    }
    setError(`Couldn't delete your account — ${result.message}.`);
    setDeletingAccount(false);
  }

  async function loadMoreRuns() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await fetch(`/api/account/runs?cursor=${encodeURIComponent(nextCursor)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`http-${response.status}`);
      const page = accountRunsResponseSchema.parse(await response.json());
      setRuns((previous) => {
        const existing = new Set(previous.map((run) => run.id));
        return [...previous, ...page.runs.filter((run) => !existing.has(run.id))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      setError("Couldn't load more runs. Refresh and try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  const displayName = clerkUser?.fullName || user.handle || "Account";

  return (
    <main
      id="main-content"
      tabIndex={-1}
      style={{
        maxWidth: "var(--container-prose)",
        margin: "0 auto",
        padding: "var(--space-8) var(--space-6) var(--space-16)",
      }}
    >
      <span className="heimdall-overline">Account</span>

      <Card style={{ marginTop: "var(--space-3)" }}>
        <Card.Body
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-4)",
            flexWrap: "wrap",
          }}
        >
          <Avatar size="lg" name={displayName} src={clerkUser?.imageUrl} />
          <div style={{ flex: 1, minWidth: "var(--field-lg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <span style={{ font: "var(--type-subheading)", color: "var(--fg-1)" }}>
                {displayName}
              </span>
              {user.role === "verified" && (
                <Badge tone="brand" dot>
                  Verified reviewer
                </Badge>
              )}
              {user.role === "admin" && (
                <Badge tone="info" dot>
                  Admin
                </Badge>
              )}
            </div>
            <p style={{ font: "var(--type-body-sm)", color: "var(--fg-3)", marginTop: "var(--space-1)" }}>
              {user.email ?? "no email on file"} · signed in with Clerk
            </p>
          </div>
          <Button
            variant="secondary"
            iconLeft={<LogOutIcon size={16} />}
            onClick={() => void signOut({ redirectUrl: "/" })}
          >
            Sign out
          </Button>
        </Card.Body>
      </Card>

      <Card style={{ marginTop: "var(--space-5)" }}>
        <Card.Header title="My runs" actions={<Badge tone="neutral">{runs.length}</Badge>} />
        <Card.Body style={{ paddingTop: "var(--space-2)" }}>
          {error && (
            <p
              style={{
                font: "var(--type-body-sm)",
                color: "var(--bad)",
                marginBottom: "var(--space-3)",
              }}
            >
              {error}
            </p>
          )}
          {runs.length === 0 ? (
            <p style={{ font: "var(--type-body-sm)", color: "var(--fg-3)" }}>
              No runs yet. <Link href="/upload">Upload a benchmark log</Link> to get started.
            </p>
          ) : (
            runs.map((run) => (
              <div
                key={run.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                  padding: "var(--space-3) 0",
                  borderBottom: "var(--border-thin) solid var(--line-1)",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: 1, minWidth: "var(--field-md)" }}>
                  <Link
                    href={`/runs/${run.id}`}
                    style={{
                      font: "var(--type-body)",
                      color: "var(--fg-1)",
                      textDecoration: "none",
                    }}
                  >
                    {run.game}
                  </Link>
                  <span
                    data-mono
                    style={{ display: "block", font: "var(--type-caption)", color: "var(--fg-3)" }}
                  >
                    {MEDIUM_DATE_FORMATTER.format(new Date(run.createdAt))} ·{" "}
                    {run.avgFps.toFixed(1)}{" "}
                    avg fps
                  </span>
                </div>
                <Select
                  aria-label={`Visibility for ${run.game}`}
                  value={run.visibility}
                  onChange={(event) =>
                    void changeVisibility(run.id, event.target.value as RunVisibility)
                  }
                  options={VISIBILITY_OPTIONS}
                  disabled={busyId === run.id}
                  style={{ width: "var(--field-sm)" }}
                />
                <IconButton
                  aria-label={`Delete ${run.game}`}
                  disabled={busyId === run.id}
                  onClick={() => void removeRun(run.id)}
                >
                  <TrashIcon size={18} />
                </IconButton>
              </div>
            ))
          )}
          {nextCursor && (
            <Button
              variant="secondary"
              size="sm"
              loading={loadingMore}
              onClick={() => void loadMoreRuns()}
              style={{ marginTop: "var(--space-3)" }}
            >
              Load more
            </Button>
          )}
          <p
            style={{
              font: "var(--type-caption)",
              color: "var(--fg-3)",
              marginTop: "var(--space-3)",
            }}
          >
            Private runs 404 for everyone but you. Deleting a run also removes its stored frame
            data.
          </p>
        </Card.Body>
      </Card>

      <Card style={{ marginTop: "var(--space-5)" }}>
        <Card.Header title="Data & privacy" />
        <Card.Body style={{ display: "grid", gap: "var(--space-3)" }}>
          <p style={{ font: "var(--type-body-sm)", color: "var(--fg-2)" }}>
            See our <Link href="/privacy">privacy policy</Link> for what&apos;s collected and why.
            Right to erasure — deleting your account cascades to every run you own and its stored
            frame data.
          </p>
          {!confirmingDelete ? (
            <div>
              <Button
                variant="danger"
                size="sm"
                iconLeft={<TrashIcon size={15} />}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete account
              </Button>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                flexWrap: "wrap",
              }}
            >
              <p style={{ font: "var(--type-body-sm)", color: "var(--bad)" }}>
                This permanently deletes your account and every run you own. Are you sure?
              </p>
              <Button
                variant="danger"
                size="sm"
                loading={deletingAccount}
                onClick={() => void removeAccount()}
              >
                Yes, delete everything
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={deletingAccount}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </Button>
            </div>
          )}
        </Card.Body>
      </Card>
    </main>
  );
}
