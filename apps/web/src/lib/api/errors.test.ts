import { describe, expect, it } from "vitest";

import { readApiFailure } from "./errors";

describe("readApiFailure", () => {
  it("returns a valid shared API error envelope", async () => {
    await expect(
      readApiFailure(
        Response.json({ error: { code: "not-found", message: "run not found" } }, { status: 404 }),
        "request failed",
      ),
    ).resolves.toEqual({ code: "not-found", message: "run not found" });
  });

  it("falls back for malformed or non-JSON responses", async () => {
    await expect(readApiFailure(new Response("upstream failed", { status: 502 }), "request failed")).resolves.toEqual({
      code: "http-502",
      message: "request failed",
    });
  });
});
