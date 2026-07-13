import type { ConfidenceLevel } from "@heimdall/shared";

/** Shared semantic treatment for every confidence badge on the run page. */
export const CONFIDENCE_TONE: Record<ConfidenceLevel, "warn" | "info" | "good"> = {
  low: "warn",
  medium: "info",
  high: "good",
};

export const CONFIDENCE_LABEL: Record<ConfidenceLevel, string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};
