import { describe, expect, it } from "vitest";
import { getOrCreateBrowserBenchmarkSet } from "./benchmark-set";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("browser benchmark-set identity (§16c.2)", () => {
  it("keeps a display label local while reusing its opaque id and capability", () => {
    const storage = memoryStorage();
    const first = getOrCreateBrowserBenchmarkSet("Dogtown ultra 1440p", storage);
    const repeated = getOrCreateBrowserBenchmarkSet("  dogtown ultra 1440p  ", storage);
    const separate = getOrCreateBrowserBenchmarkSet("Dogtown ultra 1080p", storage);

    expect(first).toBeDefined();
    expect(repeated).toEqual(first);
    expect(separate).toBeDefined();
    expect(separate?.id).not.toBe(first?.id);
    expect(first?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first?.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("does not create a set when the display label is blank", () => {
    expect(getOrCreateBrowserBenchmarkSet("   ", memoryStorage())).toBeUndefined();
  });
});
