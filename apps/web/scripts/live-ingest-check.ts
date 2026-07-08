/**
 * Live end-to-end ingest check against a running dev server (Phase 4 exit
 * criteria): real parse → real presigned PUT to R2 → finalize → drain →
 * signed frames read → token delete. Run: `tsx scripts/live-ingest-check.ts`.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { uploadCapture } from "../src/lib/upload/upload-run";

const base = process.env.HEIMDALL_BASE_URL ?? "http://localhost:3000";
const envFile = path.resolve(import.meta.dirname, "..", "..", "..", ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const fixture = path.resolve(
  import.meta.dirname,
  "../../../packages/parsers/fixtures/capframex/csv/nvidia-full-sensors.csv",
);
const file = new File([new Uint8Array(readFileSync(fixture))], path.basename(fixture));

const result = await uploadCapture(file, {
  game: "Cyberpunk 2077",
  visibility: "unlisted",
  transport: {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(new URL(String(input), base), init)) as typeof fetch,
    putWithProgress: async (url, bytes, contentType) => {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: bytes.slice() as unknown as BodyInit,
      });
      if (!res.ok) {
        throw new Error(`storage PUT ${res.status}: ${await res.text()}`);
      }
    },
  },
});
console.log("upload:", result.ok ? `ok run=${result.runId}` : JSON.stringify(result));
if (!result.ok) {
  process.exit(1);
}

const drain = await fetch(`${base}/api/internal/jobs/drain`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.INTERNAL_JOBS_TOKEN}` },
});
console.log("drain:", drain.status, await drain.text());

const runRes = await fetch(`${base}/api/runs/${result.runId}`);
const run = (await runRes.json()) as { status: string; summary: { avgFps: number } };
console.log("run:", runRes.status, "status:", run.status, "avgFps:", run.summary?.avgFps);

const framesRes = await fetch(`${base}/api/runs/${result.runId}/frames`);
const frames = (await framesRes.json()) as { url: string };
const download = await fetch(frames.url);
const bytes = new Uint8Array(await download.arrayBuffer());
console.log(
  "frames:",
  framesRes.status,
  "downloaded:",
  bytes.byteLength,
  "magic:",
  new TextDecoder().decode(bytes.slice(0, 4)),
);

const del = await fetch(`${base}/api/runs/${result.runId}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${result.managementToken}` },
});
const after = await fetch(`${base}/api/runs/${result.runId}`);
console.log("delete:", del.status, "then GET:", after.status);

const verdict =
  run.status === "validated" &&
  bytes.length > 0 &&
  del.status === 204 &&
  after.status === 404;
console.log(verdict ? "LIVE INGEST CHECK PASSED" : "LIVE INGEST CHECK FAILED");
process.exit(verdict ? 0 : 1);
