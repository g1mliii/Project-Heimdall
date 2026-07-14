import { describe, expect, it, vi } from "vitest";

import { fetchText } from "./fetch";

describe("fetchText", () => {
  it("rejects non-HTTPS and non-allowlisted sources before fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      fetchText("http://vendor.example/source", {
        allowedHosts: ["vendor.example"],
        fetchImpl,
      }),
    ).rejects.toThrow("not allowlisted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates every redirect before following it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://metadata.internal/latest" },
      }),
    );
    await expect(
      fetchText("https://vendor.example/source", {
        allowedHosts: ["vendor.example"],
        fetchImpl,
      }),
    ).rejects.toThrow("not allowlisted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized response bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("too large", { headers: { "content-length": "9" } }),
    );
    await expect(
      fetchText("https://vendor.example/source", {
        allowedHosts: ["vendor.example"],
        fetchImpl,
        maxBytes: 4,
      }),
    ).rejects.toThrow("exceeds 4 bytes");
  });

  it("keeps the timeout active while the body is streaming", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new Error("aborted")),
            { once: true },
          );
        },
      });
      return new Response(body);
    });
    await expect(
      fetchText("https://vendor.example/source", {
        allowedHosts: ["vendor.example"],
        fetchImpl,
        timeoutMs: 5,
      }),
    ).rejects.toThrow();
  });
});
