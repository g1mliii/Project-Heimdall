/**
 * Browser-side Parquet writer (§11.1).
 *
 * DECISION (recorded per §11.1 "pick one and record it"): frames are written
 * client-side with `hyparquet-writer` — pure JS, tens of KB — instead of the
 * multi-MB `parquet-wasm`/Arrow WASM stack, and read back server-side with
 * `hyparquet` (see lib/jobs/verify-run.ts). Same DOUBLE/BOOLEAN column
 * contract on both sides (@heimdall/shared parquet.ts), so the §11.5 server
 * recompute is bit-identical to the client's summary for honest uploads.
 *
 * Still loaded via dynamic import so the writer stays off every non-upload
 * bundle path.
 */

import { framesToColumnData } from "@heimdall/shared";
import type { FrameSample } from "@heimdall/shared";

export async function buildFramesParquet(frames: readonly FrameSample[]): Promise<Uint8Array> {
  const { parquetWriteBuffer } = await import("hyparquet-writer");
  return new Uint8Array(parquetWriteBuffer({ columnData: framesToColumnData(frames) }));
}
