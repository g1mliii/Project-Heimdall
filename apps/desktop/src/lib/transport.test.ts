/**
 * Transport adapter coverage (§22.5) — runs on the ubuntu CI runner, so the
 * Tauri modules are mocked rather than loaded.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { tauriFetch, invoke, listen } = vi.hoisted(() => ({
  tauriFetch: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: tauriFetch }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const { createDesktopTransport, createSigner, resolveUrl } = await import("./transport");

beforeEach(() => {
  tauriFetch.mockReset().mockResolvedValue(new Response("{}"));
  invoke.mockReset().mockResolvedValue(undefined);
  listen.mockReset().mockResolvedValue(() => {});
});

describe("resolveUrl", () => {
  it("absolute-izes the engine's relative API paths against the hub origin", () => {
    expect(resolveUrl("https://hub.example", "/api/runs")).toBe("https://hub.example/api/runs");
    expect(resolveUrl("https://hub.example/", "/api/runs")).toBe("https://hub.example/api/runs");
  });

  it("passes presigned storage URLs through untouched", () => {
    const presigned = "https://r2.example.test/put?sig=abc";
    expect(resolveUrl("https://hub.example", presigned)).toBe(presigned);
  });
});

describe("createDesktopTransport", () => {
  it("routes API calls through the Tauri HTTP plugin, not the webview", () => {
    // A plain webview fetch would be blocked: the CSP allows no remote origins.
    const transport = createDesktopTransport("http://localhost:3000");
    void transport.fetch("/api/runs", { method: "POST" });
    expect(tauriFetch).toHaveBeenCalledWith("http://localhost:3000/api/runs", { method: "POST" });
  });

  it("delegates the PUT to Rust and forwards progress events", async () => {
    let emit: ((payload: { sentBytes: number; totalBytes: number }) => void) | undefined;
    const unlisten = vi.fn();
    listen.mockImplementation(async (_event: string, handler: (message: unknown) => void) => {
      emit = (payload) => handler({ payload });
      return unlisten;
    });
    invoke.mockImplementation(async () => {
      emit?.({ sentBytes: 512, totalBytes: 1024 });
      emit?.({ sentBytes: 1024, totalBytes: 1024 });
    });

    const seen: number[] = [];
    const transport = createDesktopTransport("http://localhost:3000");
    await transport.putWithProgress(
      "https://r2.example.test/put",
      new Uint8Array([1, 2, 3]),
      "application/vnd.apache.parquet",
      (sent) => seen.push(sent),
    );

    // The bytes argument is deliberately unused: Rust uploads the exact buffer
    // it signed in prepare_payload, so the signature cannot drift from the
    // uploaded object.
    expect(invoke).toHaveBeenCalledWith("put_prepared_payload", {
      url: "https://r2.example.test/put",
    });
    expect(seen).toEqual([512, 1024]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("stops listening for progress even when the PUT fails", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    invoke.mockRejectedValue({ code: "upload-failed", message: "network dropped" });

    const transport = createDesktopTransport("http://localhost:3000");
    await expect(
      transport.putWithProgress("https://r2.example.test/put", new Uint8Array(), "x", () => {}),
    ).rejects.toMatchObject({ code: "upload-failed" });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("createSigner", () => {
  it("returns the signature prepare_payload produced", async () => {
    invoke.mockResolvedValue({ signature: "c2ln", byteLength: 3 });
    await expect(createSigner()(new Uint8Array([1, 2, 3]))).resolves.toBe("c2ln");
    expect(invoke).toHaveBeenCalledWith("prepare_payload", expect.any(Uint8Array));
  });

  it("returns undefined for a build with no embedded key, so upload continues unsigned", () => {
    invoke.mockResolvedValue({ byteLength: 3 });
    return expect(createSigner()(new Uint8Array([1]))).resolves.toBeUndefined();
  });
});
