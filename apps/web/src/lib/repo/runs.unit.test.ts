import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../db";
import {
  claimRun,
  hideAuthorizedRunForDeletion,
  readVisibleFramesState,
  updateRunVisibility,
} from "./runs";

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

    await expect(readVisibleFramesState("run_123", null, db)).resolves.toEqual({
      framesObjectKey: "runs/run_123.parquet",
    });
    expect(query.mock.calls[0]?.[0]).not.toContain("run_summaries");
  });

  it("hides private frame state from a stranger (or logged-out owner)", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { visibility: "private", status: "validated", user_id: "user_owner", frames_object_key: "runs/secret" },
        ],
      }),
    } as unknown as Queryable;

    await expect(readVisibleFramesState("run_private", null, db)).resolves.toBeNull();
    await expect(
      readVisibleFramesState("run_private", { userId: "user_stranger" }, db),
    ).resolves.toBeNull();
  });

  it("reveals private frame state to its signed-in owner (§20.2)", async () => {
    const db = {
      query: vi.fn().mockResolvedValue({
        rows: [
          { visibility: "private", status: "validated", user_id: "user_owner", frames_object_key: "runs/secret" },
        ],
      }),
    } as unknown as Queryable;

    await expect(
      readVisibleFramesState("run_private", { userId: "user_owner" }, db),
    ).resolves.toEqual({ framesObjectKey: "runs/secret" });
  });
});

describe("terminal and authorization-aware run mutations", () => {
  it("conditions a token delete on the same stored hash that was verified", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ frames_object_key: "runs/run_123/object.parquet" }] });
    const db = { query } as unknown as Queryable;

    await expect(
      hideAuthorizedRunForDeletion(
        "run_123",
        { ownerId: null, tokenHash: "verified-hash", isAdmin: false },
        db,
      ),
    ).resolves.toEqual({ framesObjectKey: "runs/run_123/object.parquet" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("anonymous_management_token_hash = $5::text"), [
      "run_123",
      "hidden",
      false,
      null,
      "verified-hash",
    ]);
  });

  it("refuses to claim or change visibility of a terminal run", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const db = { query } as unknown as Queryable;

    await expect(claimRun("run_123", "user_owner", "token-hash", db)).resolves.toBe(false);
    await expect(updateRunVisibility("run_123", "public", db)).resolves.toBe(false);

    expect(String(query.mock.calls[0]?.[0])).toContain("status not in ('hidden', 'moderated')");
    expect(String(query.mock.calls[1]?.[0])).toContain("status not in ('hidden', 'moderated')");
  });
});
