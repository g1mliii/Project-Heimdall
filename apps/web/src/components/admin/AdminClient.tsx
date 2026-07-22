"use client";

/**
 * /admin client half (§20.3/§20.5): verified-reviewer grant form + open
 * reports queue (dismiss / hide the reported run). Minimal by design — this
 * is an operator tool, not a polished surface.
 */

import * as React from "react";
import { Badge, Button, Card, Input } from "@heimdall/ui";
import { adminReportsResponseSchema, type ReportRow } from "@heimdall/shared";
import {
  grantVerification,
  moderateRun,
  renameGame,
  updateReportStatus,
  type ApiResult,
} from "@/lib/api/client";
import { MEDIUM_DATE_FORMATTER, REPORT_REASON_LABELS } from "@/lib/format";

/**
 * One admin form's busy flag + last outcome. The two forms here differ only in
 * which request they send, so the submit/report cycle lives once.
 */
function useAdminAction() {
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);

  async function run(send: () => Promise<ApiResult<void>>, done: string): Promise<void> {
    setBusy(true);
    setResult(null);
    const outcome = await send();
    setResult(outcome.ok ? done : `Failed — ${outcome.message}.`);
    setBusy(false);
  }

  return { busy, result, run };
}

export function AdminClient({
  initialReports,
  initialNextCursor,
}: {
  initialReports: ReportRow[];
  initialNextCursor: string | null;
}) {
  const [reports, setReports] = React.useState(initialReports);
  const [nextCursor, setNextCursor] = React.useState(initialNextCursor);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const [grantUserId, setGrantUserId] = React.useState("");
  const grant = useAdminAction();

  const [renameGameId, setRenameGameId] = React.useState("");
  const [renameGameName, setRenameGameName] = React.useState("");
  const rename = useAdminAction();

  /** Queue actions all end the same way: drop the row, or explain why not. */
  async function resolveReport(
    id: string,
    send: () => Promise<ApiResult<void>>,
    failure: string,
  ): Promise<void> {
    setBusyId(id);
    setError(null);
    const outcome = await send();
    if (outcome.ok) {
      setReports((prev) => prev.filter((report) => report.id !== id));
    } else {
      setError(`${failure} — ${outcome.message}.`);
    }
    setBusyId(null);
  }

  async function loadMoreReports(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/reports?cursor=${encodeURIComponent(nextCursor)}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`http-${response.status}`);
      }
      const page = adminReportsResponseSchema.parse(await response.json());
      setReports((previous) => {
        const existing = new Set(previous.map((report) => report.id));
        return [...previous, ...page.reports.filter((report) => !existing.has(report.id))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      setError("Couldn't load more reports. Refresh and try again.");
    } finally {
      setLoadingMore(false);
    }
  }

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
      <span className="heimdall-overline">Admin</span>

      <Card style={{ marginTop: "var(--space-3)" }}>
        <Card.Header title="Grant verified reviewer" />
        <Card.Body style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
          <Input
            label="Clerk user id"
            value={grantUserId}
            onChange={(event) => setGrantUserId(event.target.value)}
            placeholder="user_..."
            style={{ minWidth: "var(--field-xl)" }}
          />
          <Button
            variant="primary"
            loading={grant.busy}
            disabled={grantUserId.trim() === ""}
            onClick={() =>
              void grant.run(
                () => grantVerification({ userId: grantUserId.trim(), hardwareVetted: true }),
                "Granted.",
              )
            }
          >
            Grant
          </Button>
          {grant.result && (
            <span style={{ font: "var(--type-body-sm)", color: "var(--fg-2)" }}>{grant.result}</span>
          )}
          {nextCursor && (
            <Button
              variant="secondary"
              size="sm"
              loading={loadingMore}
              onClick={() => void loadMoreReports()}
              style={{ marginTop: "var(--space-3)" }}
            >
              Load more
            </Button>
          )}
        </Card.Body>
      </Card>

      <Card style={{ marginTop: "var(--space-5)" }}>
        <Card.Header title="Rename a game" />
        <Card.Body style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
          <Input
            label="Game id"
            value={renameGameId}
            onChange={(event) => setRenameGameId(event.target.value)}
            placeholder="123"
            style={{ width: "var(--field-xs)" }}
          />
          <Input
            label="New name"
            value={renameGameName}
            onChange={(event) => setRenameGameName(event.target.value)}
            style={{ minWidth: "var(--field-xl)" }}
          />
          <Button
            variant="primary"
            loading={rename.busy}
            disabled={renameGameId.trim() === "" || renameGameName.trim() === ""}
            onClick={() =>
              void rename.run(
                () => renameGame(renameGameId.trim(), renameGameName.trim()),
                "Renamed.",
              )
            }
          >
            Rename
          </Button>
          {rename.result && (
            <span style={{ font: "var(--type-body-sm)", color: "var(--fg-2)" }}>
              {rename.result}
            </span>
          )}
        </Card.Body>
      </Card>

      <Card style={{ marginTop: "var(--space-5)" }}>
        <Card.Header title="Open reports" actions={<Badge tone="neutral">{reports.length}</Badge>} />
        <Card.Body style={{ paddingTop: "var(--space-2)" }}>
          {error && (
            <p style={{ font: "var(--type-body-sm)", color: "var(--bad)", marginBottom: "var(--space-3)" }}>
              {error}
            </p>
          )}
          {reports.length === 0 ? (
            <p style={{ font: "var(--type-body-sm)", color: "var(--fg-3)" }}>No open reports.</p>
          ) : (
            reports.map(({ id, subjectType, subjectRunId, subjectGameId, reason, detail, createdAt }) => (
              <div
                key={id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                  padding: "var(--space-3) 0",
                  borderBottom: "var(--border-thin) solid var(--line-1)",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: 1, minWidth: "var(--field-lg)" }}>
                  <span style={{ font: "var(--type-body)", color: "var(--fg-1)" }}>
                    {subjectType === "run" ? "Run" : "Game"} · {subjectRunId ?? subjectGameId}
                  </span>
                  <span
                    data-mono
                    style={{ display: "block", font: "var(--type-caption)", color: "var(--fg-3)" }}
                  >
                    {REPORT_REASON_LABELS[reason]} ·{" "}
                    {MEDIUM_DATE_FORMATTER.format(new Date(createdAt))}
                  </span>
                  {detail && (
                    <p style={{ font: "var(--type-body-sm)", color: "var(--fg-2)", marginTop: "var(--space-1)" }}>
                      {detail}
                    </p>
                  )}
                </div>
                {subjectRunId && (
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busyId === id}
                    onClick={() =>
                      void resolveReport(
                        id,
                        () => moderateRun(subjectRunId),
                        "Couldn't hide that run",
                      )
                    }
                  >
                    Hide run
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busyId === id}
                  onClick={() =>
                    void resolveReport(
                      id,
                      () => updateReportStatus(id, "dismissed"),
                      "Couldn't dismiss that report",
                    )
                  }
                >
                  Dismiss
                </Button>
              </div>
            ))
          )}
        </Card.Body>
      </Card>
    </main>
  );
}
