import { describe, expect, it, vi } from "vitest";
import { validRun } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import type { Queryable } from "./db";
import { diagnosticInsertSql, insertRun, readRunForVerification, SqlParams } from "./db";

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
  const finding = {
    code: "vram-saturation",
    severity: "warn",
    title: "VRAM",
    detail: "d",
  } as const;

  it("numbers its own placeholders from wherever the caller has got to", () => {
    // Standalone: run id first, then the seven unnested arrays.
    const standalone = new SqlParams();
    const sql = diagnosticInsertSql(standalone, standalone.add("run_1"), [finding]);
    expect(sql).toContain(
      "unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])",
    );
    expect(sql).toContain(
      "insert into diagnostics (run_id, code, severity, title, detail, evidence, rule_version, confidence, evaluated_at)",
    );
    expect(standalone.all).toHaveLength(8);

    // Mid-statement: the same fragment, continuing another statement's
    // numbering. Nothing here is hand-computed, which is the point.
    const shared = new SqlParams();
    shared.addAll(Array.from({ length: 18 }, (_, i) => i));
    const nested = diagnosticInsertSql(
      shared,
      "$1",
      [finding],
      "exists (select 1 from run_update)",
    );
    expect(nested).toContain(
      "unnest($19::text[], $20::text[], $21::text[], $22::text[], $23::text[], $24::text[], $25::text[])",
    );
    expect(nested).toContain("where exists (select 1 from run_update)");
    expect(shared.all).toHaveLength(25);
  });
});

describe("insertRun parameter binding", () => {
  /**
   * `insertRun` binds fifty-odd positional parameters across three CTEs and had
   * no DB-free coverage, so a mis-mapped column could only be caught by the
   * Postgres tier — which is skipped without Docker. These resolve the INSERT
   * select-lists against the parameter array and check that values land in the
   * columns they are named for.
   *
   * Every value here is distinct, which the shared fixture's are not: `validRun`
   * has equal rated and actual RAM speeds, so transposing that pair — the
   * classic positional bug, two same-typed integers side by side — is invisible
   * against it. A binding test is only as good as its ability to tell the
   * columns apart.
   */
  const distinctRun: Run = {
    ...validRun,
    hardware: {
      ...validRun.hardware,
      ramRatedSpeedMtps: 6000,
      ramSpeedMtps: 4800,
      gpuVramTotalMb: 12288,
    },
    summary: {
      ...validRun.summary,
      avgFps: 144.1,
      onePercentLowFps: 98.2,
      pointOnePercentLowFps: 71.3,
      frameTimeP50Ms: 6.94,
      frameTimeP95Ms: 10.18,
      frameTimeP99Ms: 13.27,
      stutterCount: 12,
      sampleCount: 7200,
      durationSeconds: 60.4,
    },
  };

  async function captureInsertRun(): Promise<[string, unknown[]]> {
    const query = vi.fn().mockResolvedValue({ rows: [{ run_id: "r", owner_writable: true }] });
    await insertRun(distinctRun, { query } as unknown as Queryable);
    return query.mock.calls[0] as [string, unknown[]];
  }

  /** column name → the value bound to the placeholder in its select-list slot. */
  function boundColumns(sql: string, params: unknown[]): Map<string, unknown> {
    const match = /insert into runs \(([\s\S]*?)\) select([\s\S]*?)where \(/.exec(sql);
    expect(match, "runs insert not found").not.toBeNull();
    const columns = (match?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const values = (match?.[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    expect(values).toHaveLength(columns.length);
    return new Map(
      columns.map((column, i) => {
        const placeholder = /\$(\d+)/.exec(values[i]!);
        expect(placeholder, `${column} is not bound to a placeholder`).not.toBeNull();
        return [column, params[Number(placeholder![1]) - 1]];
      }),
    );
  }

  it("lands each run column on its own value", async () => {
    const [sql, params] = await captureInsertRun();
    const bound = boundColumns(sql, params);

    expect(bound.get("id")).toBe(distinctRun.id);
    expect(bound.get("game_raw")).toBe(distinctRun.game);
    expect(bound.get("capture_source")).toBe(distinctRun.captureSource);
    expect(bound.get("visibility")).toBe(distinctRun.visibility);
    expect(bound.get("status")).toBe(distinctRun.status);
    expect(bound.get("cpu_model")).toBe(distinctRun.hardware.cpu);
    expect(bound.get("gpu_model")).toBe(distinctRun.hardware.gpu);
    expect(bound.get("gpu_driver")).toBe(distinctRun.hardware.gpuDriver);
    expect(bound.get("ram_gb")).toBe(distinctRun.hardware.ramGb);
    // The pair most likely to be transposed, since both are MT/s integers.
    expect(bound.get("ram_rated_mtps")).toBe(distinctRun.hardware.ramRatedSpeedMtps);
    expect(bound.get("ram_actual_mtps")).toBe(distinctRun.hardware.ramSpeedMtps);
    expect(bound.get("parser_version")).toBe(distinctRun.parserVersion);
    expect(bound.get("frames_object_key")).toBe(distinctRun.framesObjectKey);
  });

  it("binds the summary block in run_summaries column order", async () => {
    const [sql, params] = await captureInsertRun();
    const insert = /insert into run_summaries \(([\s\S]*?)\) select ([\s\S]*?)\s+from run_row/.exec(
      sql,
    );
    expect(insert, "run_summaries insert not found").not.toBeNull();

    const columns = (insert?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const values = (insert?.[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    expect(values).toHaveLength(columns.length);
    // First column is run_id; the rest are the canonical summary columns.
    expect(columns[0]).toBe("run_id");
    const bound = new Map(
      columns.map((column, i) => {
        const placeholder = /\$(\d+)/.exec(values[i]!);
        return [column, params[Number(placeholder![1]) - 1]];
      }),
    );
    expect(bound.get("run_id")).toBe(distinctRun.id);
    expect(bound.get("avg_fps")).toBe(distinctRun.summary.avgFps);
    expect(bound.get("p1_low_fps")).toBe(distinctRun.summary.onePercentLowFps);
    expect(bound.get("p01_low_fps")).toBe(distinctRun.summary.pointOnePercentLowFps);
    expect(bound.get("stutter_count")).toBe(distinctRun.summary.stutterCount);
    expect(bound.get("sample_count")).toBe(distinctRun.summary.sampleCount);
    expect(bound.get("duration_seconds")).toBe(distinctRun.summary.durationSeconds);
  });

  it("references every parameter it supplies", async () => {
    const [sql, params] = await captureInsertRun();
    const referenced = new Set(
      (sql.match(/\$(\d+)/g) ?? []).map((token) => Number(token.slice(1))),
    );
    const missing = [];
    for (let n = 1; n <= params.length; n++) if (!referenced.has(n)) missing.push(n);
    expect(missing, `unreferenced placeholders: ${missing.join(", ")}`).toEqual([]);
    expect(Math.max(...referenced)).toBe(params.length);
  });
});

describe("SqlParams", () => {
  it("hands out placeholders in append order", () => {
    const params = new SqlParams();
    expect(params.add("a")).toBe("$1");
    expect(params.addAll(["b", "c"])).toEqual(["$2", "$3"]);
    expect(params.all).toEqual(["a", "b", "c"]);
  });

  it("lets one value be referenced from several places", () => {
    // The reason callers hold onto the returned placeholder: a run id appears
    // in four CTEs but must be bound exactly once.
    const params = new SqlParams();
    const runId = params.add("run_1");
    const sql = `where id = ${runId} or parent = ${runId}`;
    expect(sql).toBe("where id = $1 or parent = $1");
    expect(params.all).toEqual(["run_1"]);
  });
});
