/**
 * Status hero + detected-hardware rows (§22.4), per the desktop kit.
 */

import { Badge } from "@heimdall/ui";
import type { HardwareSnapshot } from "@heimdall/shared";
import type { HotkeyState } from "@/lib/ipc";
import type { Screen } from "@/lib/machine";
import { ActivityIcon, CheckIcon, RadioIcon } from "./icons";

interface StatusHeroProps {
  screen: Screen;
  captureTool: string;
}

export function StatusHero({ screen, captureTool }: StatusHeroProps) {
  const capturing = screen === "capturing";
  const complete = screen === "complete";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
      <span
        style={{
          width: 44,
          height: 44,
          borderRadius: "var(--radius-md)",
          display: "grid",
          placeItems: "center",
          background: capturing
            ? "var(--bad-dim)"
            : complete
              ? "var(--good-dim)"
              : "var(--brand-teal-dim)",
          color: capturing ? "var(--bad)" : complete ? "var(--good)" : "var(--brand-teal)",
        }}
      >
        {capturing ? <RadioIcon size={22} /> : complete ? <CheckIcon size={22} /> : <ActivityIcon size={22} />}
      </span>
      <div>
        <div style={{ font: "var(--type-subheading)", color: "var(--fg-1)" }}>
          {capturing ? "Capturing…" : complete ? "Capture complete" : "Ready to capture"}
        </div>
        <div style={{ marginTop: 2 }}>
          <Badge tone={capturing ? "bad" : complete ? "good" : "neutral"} dot={!complete}>
            {captureTool} · Windows
          </Badge>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="hw-row">
      <span className="hw-row__label">{label}</span>
      <span data-mono className="hw-row__value" title={value}>
        {value}
      </span>
    </div>
  );
}

interface HardwareRowsProps {
  game: string;
  hardware: HardwareSnapshot | null;
  hotkey: HotkeyState | null;
}

export function HardwareRows({ game, hardware, hotkey }: HardwareRowsProps) {
  // An unregistered hotkey is stated plainly in the row it belongs to, rather
  // than leaving the user to discover the key does nothing in-game (§21.3).
  const hotkeyValue =
    hotkey === null
      ? "—"
      : hotkey.status === "registered"
        ? hotkey.accelerator
        : `${hotkey.accelerator} (unavailable)`;

  return (
    <div style={{ marginBottom: 16 }}>
      <span className="heimdall-overline" style={{ display: "block", marginBottom: 6 }}>
        Detected hardware
      </span>
      <Row label="Game" value={game || "No game in the foreground"} />
      <Row label="GPU" value={hardware?.gpu ?? "—"} />
      <Row label="CPU" value={hardware?.cpu ?? "—"} />
      <Row label="Driver" value={hardware?.gpuDriver ?? "—"} />
      <Row label="Capture" value={hotkeyValue} />
    </div>
  );
}
