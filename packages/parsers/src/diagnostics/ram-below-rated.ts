/**
 * RAM-below-rated rule (§15.3). DDR memory left at JEDEC defaults instead of its
 * rated XMP/EXPO profile costs real frame rate in CPU-bound games. Fires only
 * when both the configured and rated speeds are known and the configured speed
 * trails the rated one by more than {@link DIAGNOSTICS.ramBelowRatedTolerancePct}
 * (so SPD rounding never trips it). No frame sensors — best-effort, silent when
 * the speeds are unknown.
 */

import { DIAGNOSTICS } from "@heimdall/shared";
import type { DiagnosticRule } from "./types";

export const ramBelowRatedRule: DiagnosticRule = {
  code: "ram-below-rated",
  version: "1.0.0",
  requiredSensors: [],
  evaluate({ input }) {
    const actual = input.hardware.ramSpeedMtps;
    const rated = input.hardware.ramRatedSpeedMtps;
    if (actual === undefined || rated === undefined || actual <= 0 || rated <= 0) return null;
    if (actual >= rated * (1 - DIAGNOSTICS.ramBelowRatedTolerancePct)) return null;

    return {
      severity: "warn",
      title: "RAM is running below its rated speed",
      detail:
        `Your memory is running at ${actual} MT/s but is rated for ${rated} MT/s. ` +
        `Enable its XMP/EXPO profile in the BIOS to unlock the rated speed — it can lift ` +
        `1% lows in CPU-bound games.`,
    };
  },
};
