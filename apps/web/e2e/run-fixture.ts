/**
 * The deterministic run the e2e suite renders (§13 Verify): synthetic frames
 * from the shared seeded generator, summary computed by the SAME canonical
 * math the product uses, parquet bytes built by the same writer the upload
 * path uses. The run row is seeded into the e2e Postgres (global-setup) for
 * SSR; the frames flow is mocked in the browser (frames-URL JSON + parquet
 * body), so no R2 is involved.
 */

import { computeRunSummary } from "@heimdall/parsers";
import { makeSyntheticFrames, syntheticRunBase } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import { buildFramesParquet } from "../src/lib/upload/build-parquet";

export const E2E_RUN_ID = "run_e2e_fixture1";

export const e2eFrames = makeSyntheticFrames({ seed: 7, count: 7200 });

export const e2eFixtureRun: Run = {
  ...syntheticRunBase,
  id: E2E_RUN_ID,
  summary: computeRunSummary(e2eFrames),
  framesObjectKey: `runs/${E2E_RUN_ID}/${"c".repeat(32)}.parquet`,
};

export async function e2eParquetBytes(): Promise<Buffer> {
  return Buffer.from(await buildFramesParquet(e2eFrames));
}
