import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./db";
import { diagnosticInsertSql, readRunForVerification } from "./db";

describe("verification DB hot path", () => {
  it("uses one run query that includes fresh driver lookup and signature evidence", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Queryable;

    await expect(readRunForVerification("run_123", db)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("left join games g on g.id = r.game_id");
    expect(query.mock.calls[0]?.[0]).toContain("r.signature");
  });
});

describe("diagnostic insert SQL", () => {
  it("keeps CTE and standalone placeholder layouts aligned", () => {
    expect(diagnosticInsertSql(1, 2)).toContain(
      "unnest($2::text[], $3::text[], $4::text[], $5::text[])",
    );
    expect(diagnosticInsertSql(1, 19, "exists (select 1 from run_update)")).toContain(
      "where exists (select 1 from run_update)",
    );
  });
});
