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

/**
 * The three hero variants, one row each.
 *
 * As a table rather than five parallel ternaries over the same condition: a
 * colour that disagrees with its icon is invisible in review when the two are
 * decided forty lines apart, and a fourth state would mean editing five places
 * consistently.
 */
const VARIANTS = {
  ready: {
    background: "var(--brand-teal-dim)",
    color: "var(--brand-teal)",
    Icon: ActivityIcon,
    title: "Ready to capture",
    tone: "neutral",
    dot: true,
  },
  capturing: {
    background: "var(--bad-dim)",
    color: "var(--bad)",
    Icon: RadioIcon,
    title: "Capturing…",
    tone: "bad",
    dot: true,
  },
  complete: {
    background: "var(--good-dim)",
    color: "var(--good)",
    Icon: CheckIcon,
    title: "Capture complete",
    tone: "good",
    dot: false,
  },
} as const;

export function StatusHero({ screen, captureTool }: StatusHeroProps) {
  // Onboarding never renders the hero, but it is part of `Screen`; it shares
  // the ready look rather than needing a row of its own.
  const { background, color, Icon, title, tone, dot } =
    VARIANTS[screen === "onboarding" ? "ready" : screen];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
      <span
        style={{
          width: 44,
          height: 44,
          borderRadius: "var(--radius-md)",
          display: "grid",
          placeItems: "center",
          background,
          color,
        }}
      >
        <Icon size={22} />
      </span>
      <div>
        <div style={{ font: "var(--type-subheading)", color: "var(--fg-1)" }}>{title}</div>
        <div style={{ marginTop: 2 }}>
          <Badge tone={tone} dot={dot}>
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
