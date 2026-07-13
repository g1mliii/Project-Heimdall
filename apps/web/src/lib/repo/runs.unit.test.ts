import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../db";
import { readVisibleFramesState } from "./runs";

describe("readVisibleFramesState", () => {
  it("authorizes a visible frame read without loading a run summary", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          visibility: "unlisted",
          status: "validated",
          frames_object_key: "runs/run_123.parquet",
        },
      ],
    });
    const db = { query } as unknown as Queryable;

    await expect(readVisibleFramesState("run_123", db)).resolves.toEqual({
      framesObjectKey: "runs/run_123.parquet",
    });
    expect(query.mock.calls[0]?.[0]).not.toContain("run_summaries");
  });

  it("hides private frame state", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [{ visibility: "private", status: "validated", frames_object_key: "runs/secret" }],
      }),
    } as unknown as Queryable;

    await expect(readVisibleFramesState("run_private", db)).resolves.toBeNull();
  });
});
