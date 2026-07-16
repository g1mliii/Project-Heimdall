/** Driver-only historical reconciliation. This module deliberately has no R2 dependency. */

import { DRIVER_RULES, runDiagnosticRules } from "@heimdall/parsers";
import { readRunForVerification, type Queryable } from "../db";
import {
  applyDriverRefresh,
  driverFindingsEqual,
  readStoredDriverFindings,
  REPROCESS_KIND,
  type ClaimedReprocessJob,
} from "../repo/reprocess";
import { buildDiagnosticMetadata } from "./diagnostic-input";

export type DriverRefreshOutcome =
  | { kind: "refreshed"; changed: boolean }
  | { kind: "failed"; error: string };

export async function refreshDriverFindingsJob(
  job: ClaimedReprocessJob,
  db: Queryable,
): Promise<DriverRefreshOutcome> {
  if (job.kind !== REPROCESS_KIND.driver) {
    return { kind: "failed", error: "invalid driver-refresh claim" };
  }
  const state = await readRunForVerification(job.runId, db);
  if (!state) {
    return { kind: "failed", error: "run row disappeared" };
  }

  const {
    run,
    requiredDriver,
    requiredDriverProvenance,
    driverPlatform,
    driverCatalog,
  } = state;
  const input = {
    ...buildDiagnosticMetadata({
      hardware: run.hardware,
      captureSource: run.captureSource,
      requiredDriver,
      requiredDriverProvenance,
      driverPlatform,
      driverCatalog,
    }),
    summary: run.summary,
    // Required by the shared rule context type, but never read by DRIVER_RULES.
    frames: { frameTimeMs: new Float64Array(0) },
    ...(run.capabilityManifest === undefined
      ? {}
      : { capabilityManifest: run.capabilityManifest }),
  };

  const recomputed = runDiagnosticRules(input, DRIVER_RULES);

  const stored = await readStoredDriverFindings(job.runId, db);
  const changed = !driverFindingsEqual(stored, recomputed);
  await applyDriverRefresh(job.runId, recomputed, changed, job, db);
  return { kind: "refreshed", changed };
}
