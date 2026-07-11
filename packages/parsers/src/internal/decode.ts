/**
 * Input decoding shared by every parser. Accepts raw bytes or an already-
 * decoded string, sniffs UTF-16 BOMs (PowerShell `>` redirection writes
 * UTF-16LE, a common way to save PresentMon output), strips the BOM, and
 * splits lines CRLF-tolerantly. Isomorphic: `TextDecoder` is a web/Node/worker
 * global, not a Node import.
 */

/** Decode to text (lossy on invalid input — garbage bytes become U+FFFD). */
export function decodeInput(input: string | Uint8Array): string {
  const text = typeof input === "string" ? input : new TextDecoder(sniffEncoding(input)).decode(input);
  // TextDecoder strips the byte-level BOM; this handles string inputs.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** BOM sniff: UTF-16 LE/BE, else UTF-8. BOM-less UTF-16 is out of scope. */
function sniffEncoding(bytes: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  }
  return "utf-8";
}

/**
 * Split into lines on `\n`, tolerating `\r\n` (and stray `\r`) endings.
 * Trailing empty lines are dropped; interior blank lines are preserved so
 * callers keep accurate 1-based line numbers.
 */
export function splitLines(text: string): string[] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}
