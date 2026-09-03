import { describe, expect, it, vi } from "vitest";

import { fetchJson, mapWithConcurrency } from "./fetch";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("fetchJson allowlist", () => {
  it("parses an allowlisted JSON body", async () => {
    const fetchImpl = vi.fn(async () => ok({ hello: "world" }));
    await expect(
      fetchJson("https://api.steampowered.com/x", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ hello: "world" });
  });

  it("refuses plaintext HTTP", async () => {
    await expect(fetchJson("http://api.steampowered.com/x")).rejects.toThrow(/not allowlisted/);
  });

  it("refuses a host outside the allowlist", async () => {
    await expect(fetchJson("https://steamdb.info/app/730")).rejects.toThrow(/not allowlisted/);
  });

  it("refuses an explicit port on an allowlisted host", async () => {
    await expect(fetchJson("https://api.steampowered.com:8443/x")).rejects.toThrow(
      /not allowlisted/,
    );
  });

  it("refuses a redirect that leaves the allowlist", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://evil.test/x" } }),
    );
    await expect(
      fetchJson("https://api.steampowered.com/x", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/not allowlisted/);
  });

  it("follows a redirect that stays on the allowlist", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://store.steampowered.com/y" },
        }),
      )
      .mockResolvedValueOnce(ok({ moved: true }));
    await expect(
      fetchJson("https://api.steampowered.com/x", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toEqual({ moved: true });
  });

  it("rejects a body over the cap before reading it", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ big: "x".repeat(100) }), {
          status: 200,
          headers: { "content-length": "999999" },
        }),
    );
    await expect(
      fetchJson("https://api.steampowered.com/x", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxBytes: 16,
      }),
    ).rejects.toThrow(/exceeds 16 bytes/);
  });

  it("surfaces a non-OK status rather than parsing an error page", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 429 }));
    await expect(
      fetchJson("https://api.steampowered.com/x", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 429/);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms / 10));
      return ms;
    });
    expect(results).toEqual([
      { ok: true, value: 30 },
      { ok: true, value: 10 },
      { ok: true, value: 20 },
    ]);
  });

  it("isolates a failure instead of discarding the batch", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it("never exceeds the requested width", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("rejects a nonsensical width", async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(/at least 1/);
  });
});
