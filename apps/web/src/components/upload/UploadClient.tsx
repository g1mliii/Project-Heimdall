"use client";

/**
 * Upload/ingest flow (§11.1–§11.4, §11.8) — production port of the
 * design/ui_kits/web/extras.jsx UploadPage reference: idle → parsing →
 * done, plus the per-file batch flow where one bad file never blocks the
 * rest. All heavy lifting lives in lib/upload/upload-run.ts; this component
 * is state + tokens + @heimdall/ui primitives only.
 */

import * as React from "react";
import { Badge, Button, Card, Checkbox, Diagnostic, Input, Spinner, Stat } from "@heimdall/ui";
import { uploadCapture } from "@/lib/upload/upload-run";
import type { UploadProgress, UploadResult, UploadSuccess } from "@/lib/upload/upload-run";
import {
  ArrowRightIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  FolderUpIcon,
  UploadCloudIcon,
  XIcon,
} from "./icons";

type Visibility = "unlisted" | "public";

interface BatchItem {
  file: File;
  status: "queued" | "working" | "done" | "error";
  frames?: number;
  runId?: string;
  managementToken?: string;
  error?: string;
}

type Mode =
  | { kind: "idle" }
  | { kind: "single"; fileName: string; progress: UploadProgress }
  | { kind: "single-done"; fileName: string; result: UploadSuccess }
  | { kind: "single-error"; fileName: string; message: string }
  | { kind: "batch"; items: BatchItem[] };

const BATCH_CONCURRENCY = 2;

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function progressLine(progress: UploadProgress): { title: string; data: string } {
  switch (progress.stage) {
    case "parsing":
      return { title: "Parsing…", data: "reading frames in your browser" };
    case "building-parquet":
      return {
        title: "Computing summary…",
        data: `${progress.frames.toLocaleString()} frames → parquet`,
      };
    case "creating":
      return { title: "Creating run…", data: "requesting a direct upload slot" };
    case "uploading":
      return {
        title: "Uploading…",
        data: `${formatMb(progress.sentBytes)} / ${formatMb(progress.totalBytes)} MB direct to storage`,
      };
    case "finalizing":
      return { title: "Finalizing…", data: "queueing server-side verification" };
    case "done":
      return { title: "Done", data: progress.runId };
  }
}

export function UploadClient() {
  const [mode, setMode] = React.useState<Mode>({ kind: "idle" });
  const [game, setGame] = React.useState("");
  const [gameError, setGameError] = React.useState<string | null>(null);
  const [visibility, setVisibility] = React.useState<Visibility>("unlisted");
  const [dragOver, setDragOver] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const busy = mode.kind === "single" || mode.kind === "batch";

  async function startSingle(file: File) {
    setMode({ kind: "single", fileName: file.name, progress: { stage: "parsing" } });
    const result: UploadResult = await uploadCapture(file, {
      game,
      visibility,
      onProgress: (progress) =>
        setMode((prev) =>
          prev.kind === "single" ? { ...prev, progress } : prev,
        ),
    });
    setMode(
      result.ok
        ? { kind: "single-done", fileName: file.name, result }
        : { kind: "single-error", fileName: file.name, message: result.message },
    );
  }

  async function startBatch(files: File[]) {
    let items: BatchItem[] = files.map((file) => ({ file, status: "queued" }));
    setMode({ kind: "batch", items });
    const update = (index: number, patch: Partial<BatchItem>) => {
      items = items.map((item, i) => (i === index ? { ...item, ...patch } : item));
      setMode({ kind: "batch", items });
    };

    const queue = files.map((_, index) => index);
    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
        for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
          update(index, { status: "working" });
          const result = await uploadCapture(items[index]!.file, { game, visibility });
          if (result.ok) {
            update(index, {
              status: "done",
              frames: result.summary.sampleCount,
              runId: result.runId,
              managementToken: result.managementToken,
            });
          } else {
            update(index, { status: "error", error: result.message });
          }
        }
      }),
    );
  }

  function acceptFiles(list: FileList | File[] | null) {
    const files = Array.from(list ?? []);
    if (busy || files.length === 0) {
      return;
    }
    if (!game.trim()) {
      setGameError("Name the game first — runs are grouped by title.");
      return;
    }
    setGameError(null);
    setCopied(false);
    if (files.length === 1) {
      void startSingle(files[0]!);
    } else {
      void startBatch(files);
    }
  }

  async function copyToken(token: string) {
    await navigator.clipboard.writeText(token);
    setCopied(true);
  }

  function downloadTokens(items: BatchItem[]) {
    const lines = items
      .filter((item) => item.status === "done" && item.managementToken)
      .map((item) => `${item.file.name}\t/runs/${item.runId}\t${item.managementToken}`);
    const blob = new Blob([`file\trun\tdelete token\n${lines.join("\n")}\n`], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "heimdall-delete-tokens.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const doneCount =
    mode.kind === "batch" ? mode.items.filter((item) => item.status === "done").length : 0;
  const batchSettled =
    mode.kind === "batch" &&
    mode.items.every((item) => item.status === "done" || item.status === "error");

  return (
    <div>
      <Input
        label="Game"
        placeholder="Cyberpunk 2077"
        value={game}
        onChange={(event) => {
          setGame(event.target.value);
          if (gameError) {
            setGameError(null);
          }
        }}
        error={gameError}
        hint={gameError ? undefined : "Runs are grouped under this title on game pages."}
        disabled={busy}
      />

      {/* Dropzone — the kit's dashed panel, all four stages. */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload benchmark logs"
        onClick={() => !busy && fileInput.current?.click()}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !busy) {
            event.preventDefault();
            fileInput.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          acceptFiles(event.dataTransfer.files);
        }}
        style={{
          marginTop: "var(--space-6)",
          borderWidth: 1.5,
          borderStyle: "dashed",
          borderColor: dragOver ? "var(--brand-teal)" : "var(--line-3)",
          borderRadius: "var(--radius-lg)",
          background: "var(--bg-raised)",
          padding: "var(--space-12)",
          textAlign: "center",
          cursor: busy ? "default" : "pointer",
        }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".csv,.json,.txt,.log"
          hidden
          onChange={(event) => {
            acceptFiles(event.target.files);
            event.target.value = "";
          }}
        />

        {(mode.kind === "idle" || mode.kind === "single-error") && (
          <>
            <div
              style={{
                width: 56,
                height: 56,
                margin: "0 auto var(--space-4)",
                borderRadius: "var(--radius-md)",
                background: "var(--brand-teal-dim)",
                color: "var(--brand-teal)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <UploadCloudIcon size={28} />
            </div>
            <p style={{ font: "var(--type-subheading)", color: "var(--fg-1)" }}>
              Drop your log here
            </p>
            <p style={{ font: "var(--type-body-sm)", color: "var(--fg-3)", marginTop: "var(--space-1)" }}>
              or click to browse · .csv .json · CapFrameX, PresentMon, or MangoHud · we parse it
              in your browser — no account needed
            </p>
          </>
        )}

        {mode.kind === "single" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--space-3)",
            }}
          >
            <Spinner size={28} />
            <p style={{ font: "var(--type-subheading)", color: "var(--fg-1)" }}>
              {progressLine(mode.progress).title} {mode.fileName}
            </p>
            <p data-mono style={{ font: "var(--type-data)", color: "var(--fg-3)" }}>
              {progressLine(mode.progress).data}
            </p>
          </div>
        )}

        {mode.kind === "single-done" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--space-3)",
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 999,
                background: "var(--good-dim)",
                color: "var(--good)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <CheckIcon size={26} />
            </div>
            <p style={{ font: "var(--type-subheading)", color: "var(--fg-1)" }}>
              Uploaded — {mode.result.summary.avgFps.toFixed(1)} avg FPS
            </p>
            <p data-mono style={{ font: "var(--type-data)", color: "var(--fg-3)" }}>
              verification queued — numbers are provisional until the server recomputes them
            </p>
          </div>
        )}

        {mode.kind === "batch" && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--space-2)",
            }}
          >
            <FolderUpIcon size={28} style={{ color: "var(--brand-teal)" }} />
            <p style={{ font: "var(--type-subheading)", color: "var(--fg-1)" }}>
              Uploading {mode.items.length} logs
            </p>
            <p data-mono style={{ font: "var(--type-data)", color: "var(--fg-3)" }}>
              parse → direct-to-R2 → finalize, per file
            </p>
          </div>
        )}
      </div>

      {mode.kind === "single-error" && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <Diagnostic severity="bad" title={`Could not ingest ${mode.fileName}`}>
            {mode.message}
          </Diagnostic>
        </div>
      )}

      {/* Single-file result: provisional summary + the shown-once delete token. */}
      {mode.kind === "single-done" && (
        <div style={{ marginTop: "var(--space-5)", display: "grid", gap: "var(--space-4)" }}>
          <Card>
            <Card.Header
              title="Run created"
              actions={<Badge tone="info">pending verification</Badge>}
            />
            <Card.Body>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-8)" }}>
                <Stat
                  label="Avg FPS"
                  value={mode.result.summary.avgFps.toFixed(1)}
                  accent="var(--tier-avg)"
                />
                <Stat
                  label="1% low"
                  value={mode.result.summary.onePercentLowFps.toFixed(1)}
                  accent="var(--tier-p1)"
                />
                <Stat
                  label="0.1% low"
                  value={mode.result.summary.pointOnePercentLowFps.toFixed(1)}
                  accent="var(--tier-p01)"
                />
                <Stat
                  label="Frames"
                  value={mode.result.summary.sampleCount.toLocaleString()}
                />
              </div>
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-3)",
                  marginTop: "var(--space-5)",
                  flexWrap: "wrap",
                }}
              >
                <a href={`/runs/${mode.result.runId}`} style={{ textDecoration: "none" }}>
                  <Button variant="primary" iconRight={<ArrowRightIcon size={16} />}>
                    View run report
                  </Button>
                </a>
                <Button variant="ghost" onClick={() => setMode({ kind: "idle" })}>
                  Upload another
                </Button>
              </div>
            </Card.Body>
          </Card>

          <Diagnostic severity="info" title="Save your delete token — it's shown once">
            <span>
              Anyone with this token can delete the run; we store only its hash, so it cannot be
              recovered later.
            </span>
            <span
              style={{
                display: "flex",
                gap: "var(--space-2)",
                marginTop: "var(--space-3)",
                alignItems: "center",
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <Input
                  mono
                  readOnly
                  value={mode.result.managementToken}
                  aria-label="Delete token"
                />
              </span>
              <Button
                variant="secondary"
                iconLeft={<CopyIcon size={15} />}
                onClick={() => void copyToken(mode.result.managementToken)}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </span>
          </Diagnostic>

          {mode.result.warnings.length > 0 && (
            <Diagnostic severity="warn" title="Parse warnings">
              {mode.result.warnings.map((warning) => (
                <span key={warning.code} style={{ display: "block" }}>
                  {warning.message}
                </span>
              ))}
            </Diagnostic>
          )}
        </div>
      )}

      {/* §11.8 per-file batch progress. */}
      {mode.kind === "batch" && (
        <div style={{ marginTop: "var(--space-5)" }}>
          <Card>
            <Card.Header
              title="Batch progress"
              actions={
                <Badge tone="neutral">
                  {doneCount} / {mode.items.length} done
                </Badge>
              }
            />
            <Card.Body>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
                {mode.items.map((item) => (
                  <div
                    key={item.file.name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-3)",
                      padding: "var(--space-2) 0",
                      borderBottomWidth: 1,
                      borderBottomStyle: "solid",
                      borderBottomColor: "var(--line-1)",
                    }}
                  >
                    <span style={{ flex: "none", width: 20, display: "grid", placeItems: "center" }}>
                      {item.status === "queued" && (
                        <ClockIcon size={15} style={{ color: "var(--fg-4)" }} />
                      )}
                      {item.status === "working" && <Spinner size={15} />}
                      {item.status === "done" && (
                        <CheckIcon size={16} style={{ color: "var(--good)" }} />
                      )}
                      {item.status === "error" && (
                        <XIcon size={16} style={{ color: "var(--bad)" }} />
                      )}
                    </span>
                    <span
                      data-mono
                      style={{
                        flex: 1,
                        font: "var(--type-data)",
                        color: item.status === "error" ? "var(--fg-2)" : "var(--fg-1)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.file.name}
                    </span>
                    <span
                      style={{
                        font: "var(--type-caption)",
                        color: item.status === "error" ? "var(--bad)" : "var(--fg-3)",
                      }}
                    >
                      {item.status === "error"
                        ? item.error
                        : item.status === "done"
                          ? `${item.frames?.toLocaleString()} frames`
                          : item.status === "working"
                            ? "uploading…"
                            : "queued"}
                    </span>
                  </div>
                ))}
                <p style={{ font: "var(--type-caption)", color: "var(--fg-3)", marginTop: "var(--space-2)" }}>
                  One bad file never blocks the rest — each succeeds or fails on its own.
                </p>
              </div>
              {batchSettled && (
                <div
                  style={{
                    display: "flex",
                    gap: "var(--space-3)",
                    marginTop: "var(--space-4)",
                    flexWrap: "wrap",
                  }}
                >
                  {doneCount > 0 && (
                    <Button variant="secondary" onClick={() => downloadTokens(mode.items)}>
                      Save delete tokens (.txt)
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => setMode({ kind: "idle" })}>
                    Upload more
                  </Button>
                </div>
              )}
            </Card.Body>
          </Card>
          {batchSettled && doneCount > 0 && (
            <div style={{ marginTop: "var(--space-4)" }}>
              <Diagnostic severity="info" title="Delete tokens are shown once">
                Save the token file if you may want to remove these runs later — we store only
                hashes.
              </Diagnostic>
            </div>
          )}
        </div>
      )}

      {/* Visibility — pre-auth model: unlisted (default) or public. */}
      <div style={{ marginTop: "var(--space-6)" }}>
        <span
          className="heimdall-overline"
          style={{ display: "block", marginBottom: "var(--space-3)" }}
        >
          Visibility
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <Checkbox
            checked={visibility === "unlisted"}
            onChange={() => setVisibility("unlisted")}
            label="Unlisted — link only, excluded from public averages"
            disabled={busy}
          />
          <Checkbox
            checked={visibility === "public"}
            onChange={() => setVisibility("public")}
            label="Public — eligible for game distributions once validated"
            disabled={busy}
          />
        </div>
      </div>
    </div>
  );
}
