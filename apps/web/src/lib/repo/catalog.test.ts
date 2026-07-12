import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../db";
import { resolveGameId, resolveHardwareId } from "./catalog";

describe("resolveGameId", () => {
  it("returns an exact source alias without issuing a redundant upsert", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ game_id: "42", exact_source: true }],
    });
    const db = { query } as unknown as Queryable;

    await expect(resolveGameId("capframex", "Cyberpunk 2077", db)).resolves.toBe("42");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain(
      "where normalized_name = $2",
    );
  });
});

describe("resolveHardwareId", () => {
  it("persists aliases under the source/name/kind key", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // alias lookup
      .mockResolvedValueOnce({ rows: [{ id: "42" }] }) // canonical lookup
      .mockResolvedValueOnce({ rows: [] }); // alias insert
    const db = { query } as unknown as Queryable;

    await expect(
      resolveHardwareId("gpu", "capframex", "AMD Radeon 780M", "amd", db),
    ).resolves.toBe("42");

    expect(query.mock.calls[0]?.[0]).toContain("ha.kind = $3");
    expect(query.mock.calls[2]?.[0]).toContain("on conflict (source, normalized_name, kind)");
    expect(query.mock.calls[2]?.[1]).toEqual([
      "42",
      "gpu",
      "capframex",
      "AMD Radeon 780M",
      "amd radeon 780m",
    ]);
  });
});
