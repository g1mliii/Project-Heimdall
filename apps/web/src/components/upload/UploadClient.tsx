"use client";

/**
 * Upload/ingest flow (§11.1–§11.4, §11.8) — production port of the
 * design/ui_kits/web/extras.jsx UploadPage reference: idle → parsing →
 * done, plus the per-file batch flow where one bad file never blocks the
 * rest. All heavy lifting lives in lib/upload/upload-run.ts; this component
 * is state + tokens + @heimdall/ui primitives only.
 */

import * as React from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Diagnostic,
  Input,
  Segmented,
  Select,
  Spinner,
  Stat,
  Switch,
} from "@heimdall/ui";
import { uploadCapture } from "@/lib/upload/upload-run";
import type {
  UploadFailure,
  UploadOptions,
  UploadProgress,
  UploadResult,
  UploadSuccess,
} from "@/lib/upload/upload-run";
import type { MethodologyManifest } from "@heimdall/shared";
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
  | { kind: "single-error"; fileName: string; message: string; recovery?: UploadFailure["recovery"] }
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

function TokenCopyField({
  token,
  ariaLabel,
  copied,
  onCopy,
}: {
  token: string;
  ariaLabel: string;
  copied: boolean;
  onCopy: (token: string) => Promise<void>;
}) {
  return (
    <span
      style={{
        display: "flex",
        gap: "var(--space-2)",
        marginTop: "var(--space-3)",
        alignItems: "center",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <Input mono readOnly value={token} aria-label={ariaLabel} />
      </span>
      <Button
        variant="secondary"
        iconLeft={<CopyIcon size={15} />}
        onClick={() => void onCopy(token)}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </span>
  );
}

export function UploadClient() {
  const [mode, setMode] = React.useState<Mode>({ kind: "idle" });
  const [game, setGame] = React.useState("");
  const [gameError, setGameError] = React.useState<string | null>(null);
  const [visibility, setVisibility] = React.useState<Visibility>("unlisted");
  const [includeMethodology, setIncludeMethodology] = React.useState(false);
  const [gameBuild, setGameBuild] = React.useState("");
  const [scene, setScene] = React.useState("");
  const [sceneType, setSceneType] = React.useState<MethodologyManifest["sceneType"]>("freeform");
  const [settingsPreset, setSettingsPreset] = React.useState("");
  const [upscaler, setUpscaler] = React.useState<MethodologyManifest["upscaler"]>("unknown");
  const [rayTracing, setRayTracing] = React.useState<MethodologyManifest["rayTracing"]>("unknown");
  const [capFps, setCapFps] = React.useState("");
  const [vsync, setVsync] = React.useState(false);
  const [vrr, setVrr] = React.useState(false);
  const [refreshHz, setRefreshHz] = React.useState("");
  const [captureTool, setCaptureTool] = React.useState("");
  const [warmupPolicy, setWarmupPolicy] = React.useState("");
  const [benchmarkSetId, setBenchmarkSetId] = React.useState("");
  const [isWarmup, setIsWarmup] = React.useState(false);
  const [hags, setHags] = React.useState<NonNullable<MethodologyManifest["hags"]>>("unknown");
  const [dragOver, setDragOver] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const busy = mode.kind === "single" || mode.kind === "batch";

  function declaredMethodology(): UploadOptions["methodology"] | undefined {
    if (!includeMethodology) return undefined;

    const parsedCapFps = Number(capFps);
    const parsedRefreshHz = Number(refreshHz);
    return {
      sceneType,
      ...(gameBuild.trim() === "" ? {} : { gameBuild: gameBuild.trim() }),
      ...(scene.trim() === "" ? {} : { scene: scene.trim() }),
      ...(settingsPreset.trim() === "" ? {} : { settingsPreset: settingsPreset.trim() }),
      upscaler,
      rayTracing,
      framePacing: {
        ...(Number.isFinite(parsedCapFps) && parsedCapFps > 0 ? { capFps: parsedCapFps } : {}),
        vsync,
        vrr,
        ...(Number.isFinite(parsedRefreshHz) && parsedRefreshHz > 0
          ? { refreshHz: parsedRefreshHz }
          : {}),
      },
      ...(captureTool.trim() === "" ? {} : { captureTool: captureTool.trim() }),
      ...(warmupPolicy.trim() === "" ? {} : { warmupPolicy: warmupPolicy.trim() }),
      hags,
    };
  }

  function declaredBenchmarkSet(): Pick<UploadOptions, "benchmarkSetId" | "isWarmup"> {
    const id = benchmarkSetId.trim();
    return id === "" ? {} : { benchmarkSetId: id, isWarmup };
  }

  async function startSingle(file: File) {
    setMode({ kind: "single", fileName: file.name, progress: { stage: "parsing" } });
    const methodology = declaredMethodology();
    const benchmarkSet = declaredBenchmarkSet();
    const result: UploadResult = await uploadCapture(file, {
      game,
      visibility,
      ...(methodology === undefined ? {} : { methodology }),
      ...benchmarkSet,
      onProgress: (progress) =>
        setMode((prev) =>
          prev.kind === "single" ? { ...prev, progress } : prev,
        ),
    });
    setMode(
      result.ok
        ? { kind: "single-done", fileName: file.name, result }
        : { kind: "single-error", fileName: file.name, message: result.message, recovery: result.recovery },
    );
  }

  async function startBatch(files: File[]) {
    let items: BatchItem[] = files.map((file) => ({ file, status: "queued" }));
    setMode({ kind: "batch", items });
    const update = (index: number, patch: Partial<BatchItem>) => {
      items = items.map((item, i) => (i === index ? { ...item, ...patch } : item));
      setMode({ kind: "batch", items });
    };

    const methodology = declaredMethodology();
    const benchmarkSet = declaredBenchmarkSet();
    const queue = files.map((_, index) => index);
    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
        for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
          update(index, { status: "working" });
          const result = await uploadCapture(items[index]!.file, {
            game,
            visibility,
            ...(methodology === undefined ? {} : { methodology }),
            ...benchmarkSet,
          });
          if (result.ok) {
            update(index, {
              status: "done",
              frames: result.summary.sampleCount,
              runId: result.runId,
              managementToken: result.managementToken,
            });
          } else {
            update(index, { status: "error", error: result.message, ...result.recovery });
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
      .filter((item) => item.runId && item.managementToken)
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
  const tokenCount =
    mode.kind === "batch" ? mode.items.filter((item) => item.runId && item.managementToken).length : 0;
  const singleProgress = mode.kind === "single" ? progressLine(mode.progress) : null;
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

      <Card variant="flat" style={{ marginTop: "var(--space-5)" }}>
        <Card.Header
          title="Reproducibility details"
          actions={
            <Switch
              checked={includeMethodology}
              onChange={(event) => setIncludeMethodology(event.target.checked)}
              label="Include"
              disabled={busy}
            />
          }
        />
        <Card.Body>
          <p style={{ font: "var(--type-body-sm)", color: "var(--fg-2)" }}>
            Optional setup details keep comparable runs together and different setups apart. They are
            stored with this run and inherit its visibility and deletion controls.
          </p>
          {includeMethodology && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, var(--space-32)), 1fr))",
                gap: "var(--space-4)",
                marginTop: "var(--space-5)",
              }}
            >
              <Input
                label="Game build"
                placeholder="2.1"
                value={gameBuild}
                onChange={(event) => setGameBuild(event.target.value)}
                disabled={busy}
              />
              <Input
                label="Scene or route"
                placeholder="Downtown benchmark loop"
                value={scene}
                onChange={(event) => setScene(event.target.value)}
                disabled={busy}
              />
              <Select
                label="Scene type"
                value={sceneType}
                onChange={(event) => setSceneType(event.target.value as MethodologyManifest["sceneType"])}
                options={[
                  { value: "benchmark-scene", label: "Benchmark scene" },
                  { value: "gameplay", label: "Gameplay" },
                  { value: "freeform", label: "Freeform" },
                ]}
                disabled={busy}
              />
              <Input
                label="Settings preset"
                placeholder="Ultra"
                value={settingsPreset}
                onChange={(event) => setSettingsPreset(event.target.value)}
                disabled={busy}
              />
              <Select
                label="Upscaler"
                value={upscaler}
                onChange={(event) => setUpscaler(event.target.value as MethodologyManifest["upscaler"])}
                options={[
                  { value: "unknown", label: "Unknown" },
                  { value: "none", label: "Off" },
                  { value: "dlss", label: "DLSS" },
                  { value: "fsr", label: "FSR" },
                  { value: "xess", label: "XeSS" },
                ]}
                disabled={busy}
              />
              <Select
                label="Ray tracing"
                value={rayTracing}
                onChange={(event) => setRayTracing(event.target.value as MethodologyManifest["rayTracing"])}
                options={[
                  { value: "unknown", label: "Unknown" },
                  { value: "off", label: "Off" },
                  { value: "on", label: "On" },
                ]}
                disabled={busy}
              />
              <Input
                label="Frame cap"
                hint="Leave empty when uncapped or unknown."
                type="number"
                placeholder="120"
                value={capFps}
                onChange={(event) => setCapFps(event.target.value)}
                disabled={busy}
              />
              <Input
                label="Display refresh (Hz)"
                type="number"
                placeholder="144"
                value={refreshHz}
                onChange={(event) => setRefreshHz(event.target.value)}
                disabled={busy}
              />
              <Input
                label="Capture tool/version"
                placeholder="PresentMon 2.3.0"
                value={captureTool}
                onChange={(event) => setCaptureTool(event.target.value)}
                disabled={busy}
              />
              <Input
                label="Warm-up policy"
                placeholder="Discard first 30 seconds"
                value={warmupPolicy}
                onChange={(event) => setWarmupPolicy(event.target.value)}
                disabled={busy}
              />
              <Input
                label="Benchmark set"
                hint="Use the same label for each repeat of this benchmark."
                placeholder="dogtown-ultra-1440p"
                value={benchmarkSetId}
                onChange={(event) => setBenchmarkSetId(event.target.value)}
                disabled={busy}
              />
              <Select
                label="HAGS state"
                value={hags}
                onChange={(event) => setHags(event.target.value as NonNullable<MethodologyManifest["hags"]>)}
                options={[
                  { value: "unknown", label: "Unknown" },
                  { value: "enabled", label: "Enabled" },
                  { value: "disabled", label: "Disabled" },
                ]}
                disabled={busy}
              />
              <div style={{ display: "flex", alignItems: "end", gap: "var(--space-5)" }}>
                <Switch
                  checked={vsync}
                  onChange={(event) => setVsync(event.target.checked)}
                  label="VSync enabled"
                  disabled={busy}
                />
                <Switch
                  checked={vrr}
                  onChange={(event) => setVrr(event.target.checked)}
                  label="VRR enabled"
                  disabled={busy}
                />
                <Switch
                  checked={isWarmup}
                  onChange={(event) => setIsWarmup(event.target.checked)}
                  label="Warm-up pass"
                  disabled={busy || benchmarkSetId.trim() === ""}
                />
              </div>
            </div>
          )}
        </Card.Body>
      </Card>

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
          borderWidth: "var(--border-thick)",
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
                width: "var(--space-14)",
                height: "var(--space-14)",
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

        {mode.kind === "single" && singleProgress && (
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
              {singleProgress.title} {mode.fileName}
            </p>
            <p data-mono style={{ font: "var(--type-data)", color: "var(--fg-3)" }}>
              {singleProgress.data}
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
                width: "var(--space-12)",
                height: "var(--space-12)",
                borderRadius: "var(--radius-pill)",
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
            <span>{mode.message}</span>
            {mode.recovery && (
              <>
                <span style={{ display: "block", marginTop: "var(--space-3)" }}>
                  Finalization may have completed. Save this token before retrying; it protects
                  <span data-mono> /runs/{mode.recovery.runId}</span> if that run exists.
                </span>
                <TokenCopyField
                  token={mode.recovery.managementToken}
                  ariaLabel="Recovery delete token"
                  copied={copied}
                  onCopy={copyToken}
                />
              </>
            )}
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
                <ButtonLink
                  as={Link}
                  href={`/runs/${mode.result.runId}`}
                  variant="primary"
                  iconRight={<ArrowRightIcon size={16} />}
                >
                  View run
                </ButtonLink>
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
            <TokenCopyField
              token={mode.result.managementToken}
              ariaLabel="Delete token"
              copied={copied}
              onCopy={copyToken}
            />
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
                {/* Keyed by index on purpose: names can collide (same-named
                    logs from different folders) and items never reorder. */}
                {mode.items.map((item, index) => (
                  <div
                    key={index}
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
                    <span style={{ flex: "none", width: "var(--space-5)", display: "grid", placeItems: "center" }}>
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
                  {tokenCount > 0 && (
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
          {batchSettled && tokenCount > 0 && (
            <div style={{ marginTop: "var(--space-4)" }}>
              <Diagnostic severity="info" title="Delete tokens are shown once">
                Save this file if you may want to remove these runs later. It also includes a
                recovery token if a finalization response was lost.
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
        <Segmented
          value={visibility}
          onChange={(value) => setVisibility(value as Visibility)}
          options={[
            { value: "unlisted", label: "Unlisted" },
            { value: "public", label: "Public" },
          ]}
          disabled={busy}
        />
        <p style={{ font: "var(--type-caption)", color: "var(--fg-3)", marginTop: "var(--space-2)" }}>
          {visibility === "unlisted"
            ? "Link only — excluded from public averages."
            : "Eligible for game distributions once validated."}
        </p>
      </div>
    </div>
  );
}
