/**
 * Bounded reads of untrusted byte streams.
 *
 * Both the ingest route and the driver-curation worker pull bodies they do not
 * control, and both must refuse to buffer an unbounded one. That cap is the
 * memory-safety property behind "never trust the client" — it lives here once
 * rather than once per app.
 *
 * Web-standard only (no Node APIs), so the Cloudflare Worker can use it too.
 */

/**
 * Read a stream fully, or give up once it exceeds `maxBytes`.
 *
 * Returns `null` — rather than throwing — when the cap is exceeded, because the
 * callers disagree about what that means: the worker raises an error, while the
 * ingest route answers 413. A throw would force the route to distinguish this
 * from a malformed-body error it already catches and reports as 400.
 *
 * Decoding is left to the caller: the worker decodes with `fatal: true` and the
 * route is lenient.
 */
export async function readAllBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body exceeds cap");
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
