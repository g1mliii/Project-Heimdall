/**
 * §22.12 write-path parameter alignment — the trap this phase was warned about.
 *
 * `applyVerificationResult` and `applyReprocessResult` both build one large CTE
 * with HARDCODED positional offsets (`diagnosticInsertSql(1, 20, …)` and
 * `(1, 18, …)`). Appending the frame-analysis parameters after the diagnostics
 * arrays is safe; renumbering into the middle is not, and that class of bug
 * writes the wrong value into the right column with NO type error and NO
 * failure from any test that only checks the rows afterwards — a jsonb column
 * accepts whatever it is handed.
 *
 * These assertions need no database: they capture the SQL and the parameter
 * array, and check that the statement references `$1..$n` with no gap and that
 * exactly `n` parameters are supplied. An off-by-one in either direction, or a
 * parameter bound to nothing, fails here on the ubuntu unit tier rather than in
 * a DB-backed suite that may be skipped locally.
 */

import { describe, expect, it, vi } from "vitest";
import { validSummary } from "@heimdall/shared";
import type { Queryable } from "../db";
import { applyVerificationResult } from "./jobs";
import {
  FULL_REPROCESS_ENQUEUE_SQL,
  REPROCESS_KIND,
  applyReprocessResult,
  enqueueFullReprocessJobs,
} from "./reprocess";

/** Highest `$n` referenced anywhere in a statement. */
function maxPlaceholder(sql: string): number {
  const found = sql.match(/\$(\d+)/g) ?? [];
  return found.reduce((max, token) => Math.max(max, Number(token.slice(1))), 0);
}

/** Every `$n` from 1..max is actually referenced — no silent gap. */
function referencedPlaceholders(sql: string): Set<number> {
  return new Set((sql.match(/\$(\d+)/g) ?? []).map((token) => Number(token.slice(1))));
}

/**
 * The full contract: the statement references `$1..$n` with no gap, and exactly
 * `n` parameters are supplied.
 *
 * A max-only check is not enough. A statement that references `$28` while
 * silently never referencing some lower `$n` still passes it — the parameter is
 * supplied, bound to nothing, and the column it was meant for keeps its old
 * value with no error from Postgres and no failure from any test that only
 * inspects rows afterwards. That is precisely the bug class these two
 * hardcoded-offset statements are exposed to.
 */
function expectParametersFullyBound(sql: string, params: unknown[]): void {
  expect(maxPlaceholder(sql)).toBe(params.length);
  const referenced = referencedPlaceholders(sql);
  const missing = [];
  for (let n = 1; n <= params.length; n++) if (!referenced.has(n)) missing.push(n);
  expect(missing, `unreferenced placeholders: ${missing.join(", ")}`).toEqual([]);
}

function captureQuery() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  return { query: query as unknown as Queryable["query"], spy: query };
}

const frameAnalysis = {
  renderedFrameAnalysis: {
    state: "available" as const,
    summary: validSummary,
    renderedCount: 120,
    generatedCount: 120,
    unknownCount: 0,
  },
  presentTimeProfile: {
    minFrameTimeMs: 0.32,
    p0_1Ms: 0.32,
    p1Ms: 0.32,
    p5Ms: 0.4,
    subMillisecondPresentCount: 120,
    subMillisecondPresentFraction: 0.5,
    adjacentSubMillisecondPairFraction: 0,
    medianOverMinRatio: 12.8,
  },
};

describe("frame-analysis write paths bind every parameter they reference", () => {
  it("applyVerificationResult", async () => {
    const { query, spy } = captureQuery();
    await applyVerificationResult(
      "run_1",
      {
        summary: validSummary,
        runStatus: "validated",
        signatureValid: true,
        diagnostics: [],
        capabilityManifest: null,
        methodologyManifest: null,
        generatedFrameTech: "none",
        ...frameAnalysis,
      },
      { id: "9", attempts: 1 },
      { query } as Queryable,
    );

    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expectParametersFullyBound(sql, params);
    // The two jsonb values are the LAST two parameters — appended, not inserted.
    expect(params.at(-2)).toBe(JSON.stringify(frameAnalysis.renderedFrameAnalysis));
    expect(params.at(-1)).toBe(JSON.stringify(frameAnalysis.presentTimeProfile));
    // And the diagnostics arrays still start where the SQL says they do.
    expect(sql).toContain("unnest($20::text[]");
    expect(sql).toContain("rendered_frame_analysis = $27::jsonb");
    expect(sql).toContain("present_time_profile = $28::jsonb");
  });

  it("applyReprocessResult", async () => {
    const { query, spy } = captureQuery();
    await applyReprocessResult(
      "run_1",
      {
        summary: validSummary,
        signatureValid: null,
        diagnostics: [],
        capabilityManifest: {
          version: 1,
          source: "presentmon",
          sensors: {} as never,
          presentationMode: "unknown",
          syncMode: "unknown",
          frameGenerationObserved: false,
          vramCapacity: { state: "unknown" },
          caveats: [],
        },
        methodologyManifest: null,
        generatedFrameTech: "none",
        ...frameAnalysis,
      },
      { attempts: 1 },
      { query } as Queryable,
    );

    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expectParametersFullyBound(sql, params);
    expect(params.at(-2)).toBe(JSON.stringify(frameAnalysis.renderedFrameAnalysis));
    expect(params.at(-1)).toBe(JSON.stringify(frameAnalysis.presentTimeProfile));
    expect(sql).toContain("unnest($18::text[]");
    expect(sql).toContain("rendered_frame_analysis = $25::jsonb");
    expect(sql).toContain("present_time_profile = $26::jsonb");
  });

  it("is NOT coalesced — a newly-unavailable analysis must overwrite, not linger", () => {
    // The two assignments immediately above these in applyReprocessResult DO use
    // coalesce($n, runs.col). Copying that pattern here would let a run keep a
    // stale rendered rate from an older algorithm version forever.
    for (const sql of [applyVerificationSql(), applyReprocessSql()]) {
      expect(sql).not.toMatch(/rendered_frame_analysis = coalesce/);
      expect(sql).not.toMatch(/present_time_profile = coalesce/);
    }
  });

  it("the fourth reprocess lane binds $6 and enqueueFullReprocessJobs supplies it", async () => {
    const { query, spy } = captureQuery();
    await enqueueFullReprocessJobs({ limit: 100 }, { query } as Queryable);

    const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe(FULL_REPROCESS_ENQUEUE_SQL);
    expectParametersFullyBound(sql, params);
    expect(params.length).toBe(6);

    // The lane itself, and its union into the candidate set.
    expect(sql).toContain("frame_analysis_candidates as materialized");
    expect(sql).toContain("r.frame_analysis_version is null");
    expect(sql).toContain("or r.frame_analysis_version < $6");
    expect(sql).toContain("select id, created_at from frame_analysis_candidates");
    // Ordering must match runs_frame_analysis_version_idx or the lane seq-scans.
    expect(sql).toContain("order by r.frame_analysis_version nulls first, r.created_at, r.id");
    expect(sql).toContain(`kind = '${REPROCESS_KIND.full}'`);
  });
});

/** Re-capture the two statements without re-running their assertions. */
function applyVerificationSql(): string {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  void applyVerificationResult(
    "run_1",
    {
      summary: validSummary,
      runStatus: "validated",
      signatureValid: null,
      diagnostics: [],
      capabilityManifest: null,
      methodologyManifest: null,
      generatedFrameTech: "none",
      ...frameAnalysis,
    },
    { id: "9", attempts: 1 },
    { query } as unknown as Queryable,
  );
  return query.mock.calls[0]?.[0] as string;
}

function applyReprocessSql(): string {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  void applyReprocessResult(
    "run_1",
    {
      summary: validSummary,
      signatureValid: null,
      diagnostics: [],
      capabilityManifest: {
        version: 1,
        source: "presentmon",
        sensors: {} as never,
        presentationMode: "unknown",
        syncMode: "unknown",
        frameGenerationObserved: false,
        vramCapacity: { state: "unknown" },
        caveats: [],
      },
      methodologyManifest: null,
      generatedFrameTech: "none",
      ...frameAnalysis,
    },
    { attempts: 1 },
    { query } as unknown as Queryable,
  );
  return query.mock.calls[0]?.[0] as string;
}
