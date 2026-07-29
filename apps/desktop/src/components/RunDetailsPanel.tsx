/**
 * Collapsible run-details form on the Complete screen (§16c, kit extension).
 *
 * The kit's Complete screen has no form; this section is the one deliberate
 * addition, because without the nine `profileRequired` fields a run uploads
 * successfully and then never pools into a single aggregate — a silent failure
 * the user would have no way to notice.
 */

import * as React from "react";
import { Badge, Input, Select } from "@heimdall/ui";
import type { ComparabilityProfileField } from "@heimdall/shared";
import {
  BOOLEAN_OPTIONS,
  FRAME_GENERATION_OPTIONS,
  GRAPHICS_API_OPTIONS,
  PROFILE_FIELD_LABELS,
  RAY_TRACING_OPTIONS,
  SCENE_TYPE_OPTIONS,
  UPSCALER_OPTIONS,
  type RunDetailsForm,
} from "@/lib/run-details";
import { ChevronDownIcon, ChevronRightIcon } from "./icons";

interface RunDetailsPanelProps {
  form: RunDetailsForm;
  missing: readonly ComparabilityProfileField[];
  onChange: <K extends keyof RunDetailsForm>(key: K, value: RunDetailsForm[K]) => void;
}

const SELECT_PLACEHOLDER = { value: "", label: "Select…" } as const;

export function RunDetailsPanel({ form, missing, onChange }: RunDetailsPanelProps) {
  const [open, setOpen] = React.useState(false);
  const isMissing = (field: ComparabilityProfileField) => missing.includes(field);
  const hint = (field: ComparabilityProfileField) =>
    isMissing(field) ? "Needed to compare this run" : undefined;

  return (
    <div className="panel">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: 8,
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--fg-1)",
          font: "var(--type-body-sm)",
        }}
      >
        {open ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
        Run details
        <span style={{ marginLeft: "auto" }}>
          {missing.length > 0 ? (
            <Badge tone="warn">{missing.length} missing</Badge>
          ) : (
            <Badge tone="good">Complete</Badge>
          )}
        </span>
      </button>

      {!open ? (
        missing.length > 0 ? (
          <p className="panel__note">
            {`Undeclared: ${missing.map((field) => PROFILE_FIELD_LABELS[field]).join(", ")}.`}
          </p>
        ) : null
      ) : (
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <p style={{ font: "var(--type-caption)", color: "var(--fg-3)", margin: 0 }}>
            Runs pool into game and hardware aggregates only when every field below matches. Leave
            one blank and the run still uploads — it just stands on its own.
          </p>

          <Input
            label="Game"
            value={form.game}
            placeholder="Cyberpunk 2077"
            onChange={(event) => onChange("game", event.target.value)}
          />
          <Input
            label={PROFILE_FIELD_LABELS.resolution}
            hint={hint("resolution")}
            mono
            value={form.resolution}
            placeholder="2560x1440"
            onChange={(event) => onChange("resolution", event.target.value)}
          />
          <Input
            label={PROFILE_FIELD_LABELS.scene}
            hint={hint("scene")}
            value={form.scene}
            placeholder="Built-in benchmark"
            onChange={(event) => onChange("scene", event.target.value)}
          />
          <Select
            label={PROFILE_FIELD_LABELS.sceneType}
            hint={hint("sceneType")}
            options={[SELECT_PLACEHOLDER, ...SCENE_TYPE_OPTIONS]}
            value={form.sceneType}
            onChange={(event) =>
              onChange("sceneType", event.target.value as RunDetailsForm["sceneType"])
            }
          />
          <Input
            label={PROFILE_FIELD_LABELS.settingsPreset}
            hint={hint("settingsPreset")}
            value={form.settingsPreset}
            placeholder="Ultra"
            onChange={(event) => onChange("settingsPreset", event.target.value)}
          />
          {/* PresentMon reports the present runtime as DXGI for both DX11 and
              DX12, so the parser refuses to guess and this has to be asked. */}
          <Select
            label={PROFILE_FIELD_LABELS.graphicsApi}
            hint={hint("graphicsApi") ?? "The capture cannot tell DX11 from DX12"}
            options={[SELECT_PLACEHOLDER, ...GRAPHICS_API_OPTIONS]}
            value={form.graphicsApi}
            onChange={(event) => onChange("graphicsApi", event.target.value)}
          />
          <Select
            label={PROFILE_FIELD_LABELS.upscaler}
            hint={hint("upscaler")}
            options={[SELECT_PLACEHOLDER, ...UPSCALER_OPTIONS]}
            value={form.upscaler}
            onChange={(event) =>
              onChange("upscaler", event.target.value as RunDetailsForm["upscaler"])
            }
          />
          <Select
            label={PROFILE_FIELD_LABELS.rayTracing}
            hint={hint("rayTracing")}
            options={[SELECT_PLACEHOLDER, ...RAY_TRACING_OPTIONS]}
            value={form.rayTracing}
            onChange={(event) =>
              onChange("rayTracing", event.target.value as RunDetailsForm["rayTracing"])
            }
          />
          <Select
            label={PROFILE_FIELD_LABELS.vsync}
            hint={hint("vsync")}
            options={[SELECT_PLACEHOLDER, ...BOOLEAN_OPTIONS]}
            value={form.vsync}
            onChange={(event) => onChange("vsync", event.target.value as RunDetailsForm["vsync"])}
          />
          {/* Not profileRequired, but a comparability key the capture cannot
              reveal — AMD frame generation is invisible to PresentMon (§22.11). */}
          <Select
            label="Frame generation"
            hint="The capture cannot detect this"
            options={[SELECT_PLACEHOLDER, ...FRAME_GENERATION_OPTIONS]}
            value={form.frameGeneration}
            onChange={(event) =>
              onChange("frameGeneration", event.target.value as RunDetailsForm["frameGeneration"])
            }
          />
          <Select
            label={PROFILE_FIELD_LABELS.vrr}
            hint={hint("vrr")}
            options={[SELECT_PLACEHOLDER, ...BOOLEAN_OPTIONS]}
            value={form.vrr}
            onChange={(event) => onChange("vrr", event.target.value as RunDetailsForm["vrr"])}
          />
        </div>
      )}
    </div>
  );
}
