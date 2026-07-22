"use client";

/**
 * "Report content" affordance (§20.5) — shared by the run page and game
 * page. Anonymous-allowed (matches POST /api/reports): no sign-in check
 * here at all. A click reveals an inline reason + optional detail form
 * rather than navigating away, so reporting never loses the reader's place.
 */

import * as React from "react";
import { Button, Input, Select } from "@heimdall/ui";
import { reportReasonSchema } from "@heimdall/shared";
import type { ReportRow } from "@heimdall/shared";
import { icon } from "@/components/icons";
import { createReport } from "@/lib/api/client";
import { REPORT_REASON_LABELS } from "@/lib/format";

const FlagIcon = icon(
  <g>
    <path d="M4 22V4" />
    <path d="M4 4h14l-2 4 2 4H4" />
  </g>,
);

type ReportReason = ReportRow["reason"];

const REASON_OPTIONS = reportReasonSchema.options.map((value) => ({
  value,
  label: REPORT_REASON_LABELS[value],
}));

type Subject = { type: "run"; id: string } | { type: "game"; id: string };

export function ReportButton({ subject }: { subject: Subject }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<ReportReason>("abusive-name");
  const [detail, setDetail] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit() {
    setStatus("sending");
    const result = await createReport({
      subjectType: subject.type,
      ...(subject.type === "run" ? { subjectRunId: subject.id } : { subjectGameId: subject.id }),
      reason,
      ...(detail.trim() === "" ? {} : { detail: detail.trim() }),
    });
    setStatus(result.ok ? "sent" : "error");
  }

  if (status === "sent") {
    return (
      <span style={{ font: "var(--type-body-sm)", color: "var(--fg-3)" }}>
        Reported — thanks for flagging this.
      </span>
    );
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" iconLeft={<FlagIcon size={15} />} onClick={() => setOpen(true)}>
        Report content
      </Button>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        flexWrap: "wrap",
      }}
    >
      <Select
        aria-label="Report reason"
        value={reason}
        onChange={(event) => setReason(event.target.value as ReportReason)}
        options={REASON_OPTIONS}
        style={{ width: "var(--field-md)" }}
      />
      <Input
        aria-label="Additional detail (optional)"
        placeholder="Additional detail (optional)"
        value={detail}
        onChange={(event) => setDetail(event.target.value)}
        style={{ minWidth: "var(--field-lg)" }}
      />
      <Button
        variant="danger"
        size="sm"
        loading={status === "sending"}
        onClick={() => void submit()}
      >
        Submit report
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {status === "error" && (
        <span style={{ font: "var(--type-caption)", color: "var(--bad)" }}>
          Couldn&apos;t submit — try again.
        </span>
      )}
    </div>
  );
}
