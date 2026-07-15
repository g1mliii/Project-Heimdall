/**
 * Why a declared benchmark set has no repeatability card (§16c.3).
 *
 * `comparabilityProfileSql` pools runs only when every declared-profile field is
 * present, so runs measured differently never share a result. A run can join a
 * set and still miss that gate — and rendering nothing at all is
 * indistinguishable from a bug, so name the gap instead.
 */

import { Card, Diagnostic } from "@heimdall/ui";
import {
  missingComparabilityProfileFields,
  type ComparabilityProfileField,
  type MethodologyManifest,
} from "@heimdall/shared";

/** The upload form's own labels, so the fix names the field to fill in. */
const FIELD_LABEL: Record<ComparabilityProfileField, string> = {
  resolution: "Resolution",
  scene: "Scene or route",
  settingsPreset: "Settings preset",
  upscaler: "Upscaler",
  rayTracing: "Ray tracing",
  graphicsApi: "Graphics API",
  vsync: "VSync",
  vrr: "VRR",
  sceneType: "Scene type",
};

function sentenceList(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

export function IncompleteProfileCard({ manifest }: { manifest?: MethodologyManifest }) {
  const missing = missingComparabilityProfileFields(manifest).map((field) => FIELD_LABEL[field]);

  return (
    <Card aria-label="Benchmark set repeatability">
      <Card.Header title="Benchmark set" />
      <Card.Body>
        {missing.length > 0 ? (
          <Diagnostic severity="info" title="Repeatability needs a complete profile">
            Heimdall pools repeats only when their method profiles match exactly, so runs
            measured differently never share a result. This run leaves {sentenceList(missing)}{" "}
            undeclared. Declare {missing.length === 1 ? "it" : "them"} on your next repeat to
            see run-to-run variance here.
          </Diagnostic>
        ) : (
          <Diagnostic severity="info" title="No comparable repeats yet">
            This run declares a complete profile, but nothing has pooled with it yet. A set
            needs public, validated repeats whose game and GPU both resolved.
          </Diagnostic>
        )}
      </Card.Body>
    </Card>
  );
}
