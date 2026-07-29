/**
 * First-run setup screen (§22.4).
 *
 * Every checklist item is wired to a real Rust check — no decorative ticks. The
 * two that can fail are what actually decides whether a capture will work:
 * PresentMon needs the account to be in Performance Log Users to open an ETW
 * session without elevation, and the bundled sidecar has to resolve.
 */

import { Button } from "@heimdall/ui";
import type { Environment } from "@/lib/ipc";
import { ArrowRightIcon, CheckIcon, ExternalLinkIcon, ShieldCheckIcon, XIcon } from "./icons";

interface OnboardingProps {
  environment: Environment;
  onContinue: () => void;
  onOpenGuide: () => void;
  onRecheck: () => void;
}

type CheckState = "pass" | "fail" | "unknown";

function stateOf(value: boolean | null): CheckState {
  if (value === null) return "unknown";
  return value ? "pass" : "fail";
}

function CheckRow({ state, label, detail }: { state: CheckState; label: string; detail?: string }) {
  const color =
    state === "pass" ? "var(--good)" : state === "fail" ? "var(--bad)" : "var(--warn)";
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
        {state === "pass" ? <CheckIcon size={16} /> : <XIcon size={16} />}
      </span>
      <span style={{ display: "grid", gap: 2 }}>
        <span style={{ font: "var(--type-body-sm)", color: "var(--fg-1)" }}>{label}</span>
        {detail === undefined ? null : (
          <span style={{ font: "var(--type-caption)", color: "var(--fg-3)" }}>{detail}</span>
        )}
      </span>
    </div>
  );
}

export function Onboarding({ environment, onContinue, onOpenGuide, onRecheck }: OnboardingProps) {
  const group = stateOf(environment.performanceLogUsers);
  const sidecar = stateOf(environment.sidecarPresent);
  const ready = group === "pass" && sidecar === "pass";

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
        Heimdall captures with Intel {environment.captureTool.replace("PresentMon ", "PresentMon ")},
        which runs without admin once your account is in the{" "}
        <strong style={{ color: "var(--fg-1)" }}>Performance Log Users</strong> group.
      </p>

      <div
        className="panel panel--roomy"
        style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 12 }}
      >
        <CheckRow
          state={group}
          label="This account is in Performance Log Users"
          detail={
            group === "pass"
              ? undefined
              : group === "unknown"
                ? "Membership could not be read. Follow the setup guide, then re-check."
                : "Add the account to the group, then sign out and back in."
          }
        />
        <CheckRow
          state={group}
          label="Signed out and back in since joining the group"
          detail={
            group === "pass"
              ? undefined
              : "Group membership is baked into your logon token — it only applies after a new sign-in."
          }
        />
        <CheckRow
          state={sidecar}
          label={`Bundled capture tool detected (${environment.captureTool})`}
          detail={
            sidecar === "pass"
              ? undefined
              : "The bundled sidecar is missing from this install. Reinstall Heimdall Capture."
          }
        />
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
