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

interface FieldSpec {
  key: keyof RunDetailsForm;
  label: string;
  /** The comparability field this answers, for the "needed to compare" hint. */
  profile?: ComparabilityProfileField;
  /** Standing hint, shown when the field is not flagged as missing. */
  note?: string;
  /** Present for a picker, absent for a free-text input. */
  options?: readonly { readonly value: string; readonly label: string }[];
  placeholder?: string;
  mono?: boolean;
}

/**
 * The form, in render order, as data.
 *
 * A table rather than eleven near-identical JSX blocks: every field needs the
 * same label / missing-hint / value / cast-and-dispatch wiring, and hand-copying
 * that eleven times is where a control ends up bound to the wrong key while
 * still typechecking.
 */
const FIELDS: readonly FieldSpec[] = [
  { key: "game", label: "Game", placeholder: "Cyberpunk 2077" },
  {
    key: "resolution",
    label: PROFILE_FIELD_LABELS.resolution,
    profile: "resolution",
    placeholder: "2560x1440",
    mono: true,
  },
  {
    key: "scene",
    label: PROFILE_FIELD_LABELS.scene,
    profile: "scene",
    placeholder: "Built-in benchmark",
  },
  {
    key: "sceneType",
    label: PROFILE_FIELD_LABELS.sceneType,
    profile: "sceneType",
    options: SCENE_TYPE_OPTIONS,
  },
  {
    key: "settingsPreset",
    label: PROFILE_FIELD_LABELS.settingsPreset,
    profile: "settingsPreset",
    placeholder: "Ultra",
  },
  {
    // PresentMon reports the present runtime as DXGI for both DX11 and DX12, so
    // the parser refuses to guess and this has to be asked.
    key: "graphicsApi",
    label: PROFILE_FIELD_LABELS.graphicsApi,
    profile: "graphicsApi",
    options: GRAPHICS_API_OPTIONS,
    note: "The capture cannot tell DX11 from DX12",
  },
  {
    key: "upscaler",
    label: PROFILE_FIELD_LABELS.upscaler,
    profile: "upscaler",
    options: UPSCALER_OPTIONS,
  },
  {
    key: "rayTracing",
    label: PROFILE_FIELD_LABELS.rayTracing,
    profile: "rayTracing",
    options: RAY_TRACING_OPTIONS,
  },
  { key: "vsync", label: PROFILE_FIELD_LABELS.vsync, profile: "vsync", options: BOOLEAN_OPTIONS },
  {
    // Not profileRequired, but a comparability key the capture cannot reveal —
    // and it is unreachable on BOTH backends (§22.11). PresentMon's FrameType
    // column needs driver instrumentation AMD does not emit, and MangoHud logs
    // no frame-type column at all, so every Linux capture carries no evidence
    // whatsoever. FSR3 and AFMF are common on Linux, so this field does real
    // work there. The note below is therefore unconditionally true, which is
    // why it is not platform-branched.
    key: "frameGeneration",
    label: "Frame generation",
    options: FRAME_GENERATION_OPTIONS,
    note: "The capture cannot detect this",
  },
  { key: "vrr", label: PROFILE_FIELD_LABELS.vrr, profile: "vrr", options: BOOLEAN_OPTIONS },
];

export function RunDetailsPanel({ form, missing, onChange }: RunDetailsPanelProps) {
  const [open, setOpen] = React.useState(false);

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

          {FIELDS.map((field) => {
            const hint =
              field.profile !== undefined && missing.includes(field.profile)
                ? "Needed to compare this run"
                : field.note;
            // `as never`: the key is a union here, so its value type is one too
            // — the same reason `applyDetection` assigns per key.
            const handleChange = (
              event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
            ) => onChange(field.key, event.target.value as never);

            return field.options === undefined ? (
              <Input
                key={field.key}
                label={field.label}
                hint={hint}
                mono={field.mono}
                value={form[field.key]}
                placeholder={field.placeholder}
                onChange={handleChange}
              />
            ) : (
              <Select
                key={field.key}
                label={field.label}
                hint={hint}
                options={[SELECT_PLACEHOLDER, ...field.options]}
                value={form[field.key]}
                onChange={handleChange}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
