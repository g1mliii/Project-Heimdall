/**
 * First-run setup screen (§22.4, §23.1).
 *
 * Every row is a check Rust actually ran — no decorative ticks. This component
 * knows nothing about what any individual check means: labels, hints and the
 * exact config lines to paste all arrive in the `EnvCheck` list, produced by the
 * side that read the group membership or the MangoHud config (src-tauri/env.rs).
 *
 * The config lines are SHOWN, never written. Heimdall does not own
 * `MangoHud.conf` and will not edit a file the user configured; telling them the
 * line to add is the whole fix and leaves them holding their own overlay.
 */

import { Button } from "@heimdall/ui";
import type { EnvCheck, Environment } from "@/lib/ipc";
import { ArrowRightIcon, CheckIcon, ExternalLinkIcon, ShieldCheckIcon, XIcon } from "./icons";

interface OnboardingProps {
  environment: Environment;
  onContinue: () => void;
  onOpenGuide: () => void;
  onRecheck: () => void;
}

/** Platform-specific framing for what the setup is even for. */
function intro(environment: Environment) {
  if (environment.platform === "linux") {
    return (
      <>
        Heimdall reads the logs <strong style={{ color: "var(--fg-1)" }}>your</strong> MangoHud
        writes — it does not install or inject an overlay of its own. Start logging with MangoHud&apos;s
        hotkey in-game and Heimdall picks the log up.
      </>
    );
  }
  if (environment.platform === "windows") {
    return (
      <>
        Heimdall captures with Intel {environment.captureTool}, which runs without admin once your
        account is in the <strong style={{ color: "var(--fg-1)" }}>Performance Log Users</strong>{" "}
        group.
      </>
    );
  }
  return <>Heimdall Capture supports Windows and Linux.</>;
}

function CheckRow({ check }: { check: EnvCheck }) {
  const color =
    check.state === "ok"
      ? "var(--good)"
      : check.state === "missing"
        ? // A non-blocking gap costs diagnostics, not the capture, so it reads
          // as a warning rather than a failure.
          check.blocking
          ? "var(--bad)"
          : "var(--warn)"
        : "var(--warn)";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <span
        style={{
          width: 18,
          height: 18,
          flex: "none",
          display: "grid",
          placeItems: "center",
          color,
          marginTop: 1,
        }}
      >
        {check.state === "ok" ? <CheckIcon size={16} /> : <XIcon size={16} />}
      </span>
      <span style={{ display: "grid", gap: 2, minWidth: "0" }}>
        <span style={{ font: "var(--type-body-sm)", color: "var(--fg-1)" }}>{check.label}</span>
        {check.hint === undefined ? null : (
          <span style={{ font: "var(--type-caption)", color: "var(--fg-3)" }}>{check.hint}</span>
        )}
        {check.lines === undefined || check.lines.length === 0 ? null : (
          <pre data-mono className="conf-lines">
            {check.lines.join("\n")}
          </pre>
        )}
      </span>
    </div>
  );
}

export function Onboarding({ environment, onContinue, onOpenGuide, onRecheck }: OnboardingProps) {
  // Only blocking checks decide readiness — the same rule `needsOnboarding` uses.
  const ready = !environment.checks.some((check) => check.blocking && check.state !== "ok");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span
          style={{
            width: 44,
            height: 44,
            borderRadius: "var(--radius-md)",
            display: "grid",
            placeItems: "center",
            background: "var(--brand-teal-dim)",
            color: "var(--brand-teal)",
          }}
        >
          <ShieldCheckIcon size={22} />
        </span>
        <div>
          <div style={{ font: "var(--type-subheading)", color: "var(--fg-1)" }}>One-time setup</div>
          <div style={{ font: "var(--type-caption)", color: "var(--fg-3)", marginTop: 2 }}>
            No administrator rights required
          </div>
        </div>
      </div>

      <p style={{ font: "var(--type-body-sm)", color: "var(--fg-2)", marginBottom: 14 }}>
        {intro(environment)}
      </p>

      <div
        className="panel panel--roomy"
        style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 12 }}
      >
        {environment.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <Button variant="secondary" block iconLeft={<ExternalLinkIcon size={15} />} onClick={onOpenGuide}>
          Open setup guide
        </Button>
        <Button variant="secondary" block onClick={onRecheck}>
          Re-check
        </Button>
        {/* Continuing while a check fails is allowed on purpose: the user may
            be fixing things in another window, and a capture attempt reports
            the real error rather than this screen guessing. */}
        <Button size="lg" block iconRight={<ArrowRightIcon size={16} />} onClick={onContinue}>
          {ready ? "Continue" : "Continue anyway"}
        </Button>
      </div>
    </div>
  );
}
