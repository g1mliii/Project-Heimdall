import { describe, expect, it } from "vitest";
import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonBody } from "./http";

describe("parseJsonBody", () => {
  it("parses a bounded valid JSON request", async () => {
    const result = await parseJsonBody(
      new Request("http://localhost/api/test", {
        method: "POST",
        body: JSON.stringify({ name: "Heimdall" }),
      }),
      z.object({ name: z.string() }),
      { maxBytes: 128 },
    );

    expect(result).toEqual({ name: "Heimdall" });
  });

  it("rejects a chunked JSON body once it exceeds the configured byte cap", async () => {
    const result = await parseJsonBody(
      new Request("http://localhost/api/test", {
        method: "POST",
        body: JSON.stringify({ note: "x".repeat(64) }),
      }),
      z.object({ note: z.string() }),
      { maxBytes: 32 },
    );

    expect(result).toBeInstanceOf(NextResponse);
    if (!(result instanceof NextResponse)) throw new Error("expected a response");
    expect(result.status).toBe(413);
    await expect(result.json()).resolves.toEqual({
      error: { code: "payload-too-large", message: "request body exceeds 32 bytes" },
    });
  });
});
