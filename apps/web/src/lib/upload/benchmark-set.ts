/**
 * Browser-local benchmark-set identity (§16c.2).
 *
 * The user-facing label is only a local convenience key. The server receives a
 * random UUID plus a random capability, never the label, so two anonymous
 * users choosing the same words cannot pool their results. Losing browser
 * storage starts a new set; that is safer than guessing membership.
 */

import { generateManagementToken } from "@heimdall/shared";

export interface BrowserBenchmarkSet {
  id: string;
  secret: string;
}

type BenchmarkSetStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_PREFIX = "heimdall.benchmark-set.v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43,128}$/;

function storageForBrowser(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(label: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(label.trim().normalize("NFC").toLowerCase())}`;
}

function parseStoredSet(value: string | null): BrowserBenchmarkSet | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      "secret" in parsed &&
      typeof parsed.id === "string" &&
      typeof parsed.secret === "string" &&
      UUID.test(parsed.id) &&
      SECRET.test(parsed.secret)
    ) {
      return { id: parsed.id, secret: parsed.secret };
    }
  } catch {
    // Corrupt local state must never become a server-side membership request.
  }
  return null;
}

/**
 * Return the stable opaque identity for a non-empty local display label.
 * Storage failure still permits the current upload (and its batch), but cannot
 * accidentally rejoin a set after reload.
 */
export function getOrCreateBrowserBenchmarkSet(
  label: string,
  storage: BenchmarkSetStorage | null = storageForBrowser(),
): BrowserBenchmarkSet | undefined {
  if (label.trim() === "") return undefined;

  const key = storageKey(label);
  try {
    const stored = parseStoredSet(storage?.getItem(key) ?? null);
    if (stored) return stored;
  } catch {
    // Treat a blocked storage read like a fresh, one-session set.
  }

  const created: BrowserBenchmarkSet = {
    id: crypto.randomUUID(),
    secret: generateManagementToken(),
  };
  try {
    storage?.setItem(key, JSON.stringify(created));
  } catch {
    // The identity remains usable for this call even when persistence is off.
  }
  return created;
}
