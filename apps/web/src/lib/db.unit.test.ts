import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "./db";
import { diagnosticInsertSql, readRunForVerification } from "./db";

describe("verification DB hot path", () => {
  it("uses one run query that includes fresh driver lookup and signature evidence", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Queryable;

    await expect(readRunForVerification("run_123", db)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("left join game_driver_requirements requirement");
    expect(query.mock.calls[0]?.[0]).toContain("left join driver_catalog catalog");
    expect(query.mock.calls[0]?.[0]).toContain("r.signature");
  });
});

describe("diagnostic insert SQL", () => {
  it("keeps CTE and standalone placeholder layouts aligned", () => {
    expect(diagnosticInsertSql(1, 2)).toContain(
      "unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])",
    );
    expect(diagnosticInsertSql(1, 2)).toContain(
      "insert into diagnostics (run_id, code, severity, title, detail, evidence, rule_version, confidence)",
    );
    expect(diagnosticInsertSql(1, 20, "exists (select 1 from run_update)")).toContain(
      "where exists (select 1 from run_update)",
    );
  });
});
