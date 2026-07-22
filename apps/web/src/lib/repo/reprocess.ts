/**
 * Phase 6.7 historical reprocess queue. Full jobs replay stored Parquet through
 * the canonical verifier; driver jobs use only Postgres metadata. Successful
 * rows are deleted, while terminal failures remain as anti-enqueue tombstones.
 */

import { isDeepStrictEqual } from "node:util";
import { DIAGNOSTIC_RULES, DRIVER_RULES } from "@heimdall/parsers";
import {
  CAPABILITY_MANIFEST_VERSION,
  DIAGNOSTICS,
  DIAGNOSTICS_RULE_GENERATION,
  writableRunStatusSql,
  type CapabilityManifest,
  type DiagnosticFinding,
  type GeneratedFrameTech,
  type MethodologyManifest,
  type RunSummary,
} from "@heimdall/shared";
import {
  diagnosticInsertColumns,
  diagnosticInsertSql,
  getPool,
  query,
  RETRY_BACKOFF_SECS_SQL,
  summaryColumns,
  summaryUpdateSql,
  type Queryable,
} from "../db";

export const REPROCESS_KIND = {
  full: "full",
  driver: "driver",
} as const;

export type ReprocessKind = (typeof REPROCESS_KIND)[keyof typeof REPROCESS_KIND];

export interface ClaimedReprocessJob {
  /** Composite queue identity, encoded only for the claim-exclusion SQL parameter. */
  key: string;
  runId: string;
  kind: ReprocessKind;
  attempts: number;
}

export interface ReprocessResult {
  summary: RunSummary;
  signatureValid: boolean | null;
  diagnostics: readonly DiagnosticFinding[];
  capabilityManifest: CapabilityManifest;
  methodologyManifest: MethodologyManifest | null;
  generatedFrameTech: GeneratedFrameTech;
}

const CURRENT_RULE_CODES = DIAGNOSTIC_RULES.map((rule) => rule.code);
const CURRENT_RULE_VERSIONS = DIAGNOSTIC_RULES.map((rule) => rule.version);
export const DRIVER_RULE_CODES = DRIVER_RULES.map((rule) => rule.code);

/**
 * Only a run that already carries a verification verdict may be reprocessed.
 *
 * `pending` is excluded for integrity, not tidiness. A pending run's
 * `run_summaries` row still holds the CLIENT's provisional numbers, and
 * `verifyRunJob` decides `validated` vs `flagged` by calling
 * `summaryMismatch(run.summary, recomputed)` — client against server. A
 * reprocess job overwrites `run_summaries` with the server recompute (it never
 * touches `status`), so a backfill that reaches a pending run first would leave
 * verification comparing the server's numbers against themselves: mismatch is
 * always null, and a tampered upload launders straight to `validated`. See
 * CLAUDE.md — integrity is server-side, and the client is never trusted.
 *
 * Nothing is lost by waiting: a pending run's own verification job derives the
 * canonical summary/capability/diagnostics from the same Parquet anyway, at the
 * current versions. `hidden` stays excluded as moderation/deletion safety.
 */
const REPROCESSABLE_STATUS_SQL = (alias: string) =>
  `${alias}.status in ('validated', 'flagged')`;

/** Exported so the scale regression can EXPLAIN the exact operator query. */
export const FULL_REPROCESS_ENQUEUE_SQL = `with current_rules as materialized (
       select code, version
         from unnest($2::text[], $3::text[]) as current_rule(code, version)
     ), capability_candidates as materialized (
       select r.id, r.created_at
         from runs r
        where r.frames_object_key is not null
          and ${REPROCESSABLE_STATUS_SQL("r")}
          and (
            r.capability_manifest_version is null
            or r.capability_manifest_version < $4
          )
          and not exists (
            select 1 from reprocess_jobs existing
             where existing.run_id = r.id
               and existing.kind = '${REPROCESS_KIND.full}'
          )
        order by r.capability_manifest_version nulls first, r.created_at, r.id
        limit $1
     ), diagnostics_generation_candidates as materialized (
       -- §17.8.0 fix: the run-level diagnostics watermark. A run below the
       -- current generation is re-evaluated even when it stores NO finding, so a
       -- rule that newly fires reaches clean runs too — closing the gap the
       -- diagnostics-join lane below could never cover.
       --
       -- The null branch is required, not defensive: a run that reaches
       -- 'flagged' through failVerificationJob never passes through
       -- applyVerificationResult, so it is reprocessable with an UNSTAMPED
       -- watermark. A "null < $5" comparison is null in Postgres, so without
       -- this branch the run is
       -- permanently invisible to diagnostics reprocessing — exactly the
       -- population §17.8.0 exists to reach. The status predicate already bounds
       -- this, and the ordering keeps it index-backed
       -- (runs_diagnostics_generation_idx, nulls first).
       select r.id, r.created_at
         from runs r
        where r.frames_object_key is not null
          and ${REPROCESSABLE_STATUS_SQL("r")}
          and (
            r.diagnostics_rule_generation is null
            or r.diagnostics_rule_generation < $5
          )
          and not exists (
            select 1 from reprocess_jobs existing
             where existing.run_id = r.id
               and existing.kind = '${REPROCESS_KIND.full}'
          )
        order by r.diagnostics_rule_generation nulls first, r.created_at, r.id
        limit $1
     -- The diagnostics-join lane below is now redundant with the generation
     -- watermark above (which covers clean AND finding-bearing runs), but is kept
     -- as a defensive second path: it still enqueues a run whose STORED finding
     -- version is stale even if its generation somehow was not advanced.
      ), diagnostic_candidates as materialized (
        -- Keep the three index-seekable stale-version ranges, but bound their
        -- UNION ALL only once at the top. The old per-range limits could
        -- materialize one full batch for every rule/range before candidates
        -- deduplicated them. UNION ALL streams, so this limit stops after one
        -- total batch without a sort or a full intermediate result.
        select stale.id, stale.created_at
          from current_rules current_rule
          cross join lateral (
            select d.run_id as id, r.created_at
              from diagnostics d
              join runs r on r.id = d.run_id
             where d.code = current_rule.code
               and d.rule_version is null
               and r.frames_object_key is not null
               and ${REPROCESSABLE_STATUS_SQL("r")}
               and not exists (
                 select 1 from reprocess_jobs existing
                  where existing.run_id = r.id
                    and existing.kind = '${REPROCESS_KIND.full}'
               )
            union all
            select d.run_id as id, r.created_at
              from diagnostics d
              join runs r on r.id = d.run_id
             where d.code = current_rule.code
               and d.rule_version < current_rule.version
               and r.frames_object_key is not null
               and ${REPROCESSABLE_STATUS_SQL("r")}
               and not exists (
                 select 1 from reprocess_jobs existing
                  where existing.run_id = r.id
                    and existing.kind = '${REPROCESS_KIND.full}'
               )
            union all
            select d.run_id as id, r.created_at
              from diagnostics d
              join runs r on r.id = d.run_id
             where d.code = current_rule.code
               and d.rule_version > current_rule.version
               and r.frames_object_key is not null
               and ${REPROCESSABLE_STATUS_SQL("r")}
               and not exists (
                 select 1 from reprocess_jobs existing
                  where existing.run_id = r.id
                    and existing.kind = '${REPROCESS_KIND.full}'
               )
          ) stale
         limit $1
      ), candidates as materialized (
       select id, created_at from capability_candidates
       union
       select id, created_at from diagnostics_generation_candidates
       union
       select id, created_at from diagnostic_candidates
     )
     insert into reprocess_jobs (run_id, kind)
     select candidate.id, '${REPROCESS_KIND.full}'
       from candidates candidate
      order by candidate.created_at, candidate.id
      limit $1
     on conflict (run_id, kind) do nothing
     returning run_id`;

export async function enqueueFullReprocessJobs(
  { limit = 1_000 }: { limit?: number } = {},
  db: Queryable = getPool(),
): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(limit, 50_000));
  const rows = await query<{ run_id: string }>(
    FULL_REPROCESS_ENQUEUE_SQL,
    [
      boundedLimit,
      CURRENT_RULE_CODES,
      CURRENT_RULE_VERSIONS,
      CAPABILITY_MANIFEST_VERSION,
      DIAGNOSTICS_RULE_GENERATION,
    ],
    db,
  );
  return rows.length;
}

export interface DriverRefreshEnqueueResult {
  enqueued: number;
  sweepRequested: boolean;
  sweepComplete: boolean;
}

/**
 * One bounded driver-refresh sweep. `limit` is the maximum number of live
 * driver jobs this sweep may retain, not a new-jobs batch size: a slow drain
 * must never turn a catalog update into an ever-growing queue.
 */
export const DRIVER_REFRESH_ENQUEUE_SQL = `with catalog_state as materialized (
       select greatest(
                (select max(fetched_at) from driver_catalog),
                (select max(fetched_at) from game_driver_requirements)
              ) as catalog_watermark
     ), stored as materialized (
       select value, updated_at
         from reprocess_watermarks
        where key = 'driver-catalog'
     ), expiry_crossed as materialized (
       -- A source's expiry deadline is a stable generation. Using now() here
       -- would make every completed run look stale again on the next bounded
       -- pass, so a multi-batch expiry sweep could never finish.
       select greatest(
                (select max(catalog.fetched_at)
                   from driver_catalog catalog
                   cross join stored
                  where catalog.fetched_at > stored.updated_at - make_interval(days => $1)
                    and catalog.fetched_at <= now() - make_interval(days => $1)),
                (select max(requirement.fetched_at)
                   from game_driver_requirements requirement
                   cross join stored
                  where requirement.fetched_at > stored.updated_at - make_interval(days => $1)
                    and requirement.fetched_at <= now() - make_interval(days => $1))
              ) + make_interval(days => $1) as watermark
     ), sweep as materialized (
       select catalog_state.catalog_watermark,
               catalog_state.catalog_watermark is not null
                 and (
                   catalog_state.catalog_watermark is distinct from stored.value
                   or expiry_crossed.watermark is not null
                 ) as requested,
               case
                 when catalog_state.catalog_watermark is distinct from stored.value
                   then catalog_state.catalog_watermark
                 else expiry_crossed.watermark
               end as source_watermark
          from catalog_state
          left join stored on true
          cross join expiry_crossed
     ), active_upsert as (
       -- updated_at is the stable time generation for this in-progress sweep,
       -- while value identifies the source state that prompted it. Keeping
       -- both prevents a retrying expiry/decrease sweep from moving its target
       -- forward on every bounded invocation.
       insert into reprocess_watermarks as active (key, value, updated_at)
       select 'driver-catalog-active', sweep.source_watermark, now()
         from sweep
        where sweep.requested
       on conflict (key) do update
          set value = excluded.value,
              updated_at = excluded.updated_at
        where active.value is distinct from excluded.value
       returning value, updated_at
     ), active_sweep as materialized (
       select value as source_watermark, updated_at as evaluate_before
         from active_upsert
       union all
       select active.value as source_watermark, active.updated_at as evaluate_before
         from reprocess_watermarks active
         join sweep on sweep.requested and active.value = sweep.source_watermark
        where active.key = 'driver-catalog-active'
          and not exists (select 1 from active_upsert)
     ), live_driver_jobs as materialized (
       select count(*)::integer as count
         from reprocess_jobs
        where kind = '${REPROCESS_KIND.driver}'
          and failed_at is null
     ), capacity as materialized (
       select greatest($2::integer - live_driver_jobs.count, 0) as available
         from live_driver_jobs
      ), candidates as materialized (
        select r.id, active_sweep.source_watermark
          from runs r
          cross join active_sweep
          cross join capacity
         where ${REPROCESSABLE_STATUS_SQL("r")}
           and (
             r.driver_evaluated_at is null
             or r.driver_evaluated_at < active_sweep.evaluate_before
           )
           -- A terminal tombstone blocks only the generation that produced it.
           -- A source move or TTL expiry gets a new stable generation and may
           -- retry; otherwise a failed first row would revive every pass and
           -- starve the rest of a bounded sweep.
           and not exists (
             select 1 from reprocess_jobs existing
              where existing.run_id = r.id
                and existing.kind = '${REPROCESS_KIND.driver}'
                and (
                  existing.failed_at is null
                  or existing.driver_source_watermark is not distinct from active_sweep.source_watermark
                )
           )
        order by r.driver_evaluated_at nulls first, r.id
        limit (select available + 1 from capacity)
      ), inserted as (
        insert into reprocess_jobs (run_id, kind, driver_source_watermark)
        select id, '${REPROCESS_KIND.driver}', source_watermark
          from candidates
         limit (select available from capacity)
        on conflict (run_id, kind) do update
           set driver_source_watermark = excluded.driver_source_watermark,
               failed_at = null,
               attempts = 0,
               locked_at = null,
               not_before = now(),
               last_error = null
         where reprocess_jobs.failed_at is not null
           and reprocess_jobs.driver_source_watermark
                 is distinct from excluded.driver_source_watermark
       returning run_id
     ), sweep_status as (
       select sweep.requested,
              sweep.catalog_watermark,
              (select count(*) from candidates) <= (select available from capacity)
                and not exists (
                  -- Keep a newer generation open while a claimed job from an
                  -- earlier generation can still become a tombstone. Otherwise
                  -- completing now would make that terminal failure ineligible
                  -- for the newer generation's one bounded retry.
                  select 1
                    from reprocess_jobs live
                    cross join active_sweep
                   where live.kind = '${REPROCESS_KIND.driver}'
                     and live.failed_at is null
                     and live.driver_source_watermark
                           is distinct from active_sweep.source_watermark
                ) as complete
         from sweep
      ), watermark_update as (
        insert into reprocess_watermarks (key, value, updated_at)
       select 'driver-catalog', catalog_watermark, now()
         from sweep_status
        where requested and complete
        on conflict (key) do update
          set value = excluded.value,
              updated_at = excluded.updated_at
      )
     select (select count(*) from inserted) as enqueued,
            coalesce((select requested from sweep_status), false) as sweep_requested,
            coalesce((select complete from sweep_status), true) as sweep_complete`;

/**
 * Enumerate a bounded driver-refresh slice only when the catalog watermark
 * moves or an individual catalog row crosses its TTL. The limit+1 probe keeps
 * the watermark open until every candidate is either queued or tombstoned.
 */
export async function enqueueDriverRefreshJobs(
  {
    limit = 1_000,
    // Must track the read path: readRunForVerification drops a catalog row once
    // it falls outside this window, so a sweep on a different TTL would either
    // miss the expiry or churn runs whose findings did not change.
    catalogMaxAgeDays = DIAGNOSTICS.driverCatalogMaxAgeDays,
  }: { limit?: number; catalogMaxAgeDays?: number } = {},
  db: Queryable = getPool(),
): Promise<DriverRefreshEnqueueResult> {
  const boundedLimit = Math.max(1, Math.min(limit, 10_000));
  const rows = await query<{
    enqueued: number | string;
    sweep_requested: boolean;
    sweep_complete: boolean;
  }>(
    DRIVER_REFRESH_ENQUEUE_SQL,
    [catalogMaxAgeDays, boundedLimit],
    db,
  );
  const row = rows[0];
  return {
    enqueued: Number(row?.enqueued ?? 0),
    sweepRequested: row?.sweep_requested ?? false,
    sweepComplete: row?.sweep_complete ?? true,
  };
}

function claimKey(kind: ReprocessKind, runId: string): string {
  return `${kind}\u001f${runId}`;
}

export async function claimNextReprocessJob(
  kind: ReprocessKind,
  {
    leaseMinutes = 10,
    excludeKeys = [],
  }: { leaseMinutes?: number; excludeKeys?: string[] } = {},
  db: Queryable = getPool(),
): Promise<ClaimedReprocessJob | null> {
  const rows = await query<{ run_id: string; kind: ReprocessKind; attempts: number }>(
    `update reprocess_jobs rj
        set locked_at = now(),
            not_before = now() + make_interval(mins => $2),
            attempts = rj.attempts + 1
      where (rj.run_id, rj.kind) = (
        select candidate.run_id, candidate.kind
          from reprocess_jobs candidate
         where candidate.kind = $1
           and candidate.failed_at is null
           and candidate.not_before <= now()
           and (candidate.kind || E'\\x1f' || candidate.run_id) <> all($3::text[])
         order by candidate.not_before, candidate.created_at, candidate.run_id
         for update skip locked
         limit 1
      )
      returning rj.run_id, rj.kind, rj.attempts`,
    [kind, leaseMinutes, excludeKeys],
    db,
  );
  const row = rows[0];
  return row
    ? {
        key: claimKey(row.kind, row.run_id),
        runId: row.run_id,
        kind: row.kind,
        attempts: row.attempts,
      }
    : null;
}

export async function completeReprocessJob(
  job: Pick<ClaimedReprocessJob, "runId" | "kind" | "attempts">,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    `delete from reprocess_jobs
      where run_id = $1
        and kind = $2
        and attempts = $3
        and locked_at is not null
        and failed_at is null`,
    [job.runId, job.kind, job.attempts],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function failReprocessJob(
  job: Pick<ClaimedReprocessJob, "runId" | "kind" | "attempts">,
  error: string,
  terminal: boolean,
  db: Queryable = getPool(),
): Promise<boolean> {
  const result = await db.query(
    `update reprocess_jobs
        set locked_at = null,
            last_error = $4,
            failed_at = case when $5::boolean then now() else null end,
            not_before = case
              when $5::boolean then now()
              else now() + make_interval(secs => ${RETRY_BACKOFF_SECS_SQL})
            end
      where run_id = $1
        and kind = $2
        and attempts = $3
        and locked_at is not null
        and failed_at is null`,
    [job.runId, job.kind, job.attempts, error.slice(0, 2_000), terminal],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Commit a full replay without touching the run's lifecycle status. */
export async function applyReprocessResult(
  runId: string,
  result: ReprocessResult,
  claim: Pick<ClaimedReprocessJob, "attempts">,
  db: Queryable = getPool(),
): Promise<void> {
  await db.query(
    `with job_claim as (
       select 1
         from reprocess_jobs
        where run_id = $1
          and kind = '${REPROCESS_KIND.full}'
          and attempts = $15
          and locked_at is not null
          and failed_at is null
     ), run_update as (
       update runs
          set signature_valid = coalesce($13, runs.signature_valid),
              generated_frame_tech = $14,
              capability_manifest = $16::jsonb,
              capability_manifest_version = ($16::jsonb ->> 'version')::integer,
              -- DIAGNOSTIC_RULES contains both driver rules, so this replay just
              -- re-evaluated them against the current catalog. Record it, or the
              -- driver sweep cannot see the work is done and queues it again.
              driver_evaluated_at = now(),
              -- This replay re-evaluated every diagnostic at the current rule
              -- generation, so advance the watermark or the diagnostics lane
              -- would re-enqueue the run forever (§17.8.0).
              diagnostics_rule_generation = ${DIAGNOSTICS_RULE_GENERATION},
              diagnostics_evaluated_at = now(),
              settings_json = coalesce($17::jsonb, runs.settings_json),
              methodology_manifest_version = coalesce(
                ($17::jsonb ->> 'version')::integer,
                runs.methodology_manifest_version
              )
        where id = $1
          and ${writableRunStatusSql()}
          and exists (select 1 from job_claim)
        returning id
     ), summary_update as (
       ${summaryUpdateSql(1, 2, "exists (select 1 from run_update)")}
     ), diagnostics_delete as (
       delete from diagnostics
        where run_id = $1
          and exists (select 1 from run_update)
     )
     ${diagnosticInsertSql(1, 18, "exists (select 1 from run_update)")}`,
    [
      runId,
      ...summaryColumns(result.summary),
      result.signatureValid,
      result.generatedFrameTech,
      claim.attempts,
      JSON.stringify(result.capabilityManifest),
      result.methodologyManifest ? JSON.stringify(result.methodologyManifest) : null,
      ...diagnosticInsertColumns(result.diagnostics),
    ],
  );
}

export async function readStoredDriverFindings(
  runId: string,
  db: Queryable = getPool(),
): Promise<DiagnosticFinding[]> {
  const rows = await query<{
    code: string;
    severity: DiagnosticFinding["severity"];
    title: string;
    detail: string;
    evidence: DiagnosticFinding["evidence"] | null;
    rule_version: string | null;
    confidence: DiagnosticFinding["confidence"] | null;
  }>(
    `select code, severity, title, detail, evidence, rule_version, confidence
       from diagnostics
      where run_id = $1
        and code = any($2::text[])
      order by id`,
    [runId, DRIVER_RULE_CODES],
    db,
  );
  return rows.map((row) => ({
    code: row.code,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    ...(row.rule_version === null ? {} : { ruleVersion: row.rule_version }),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
  }));
}

export function driverFindingsEqual(
  stored: readonly DiagnosticFinding[],
  recomputed: readonly DiagnosticFinding[],
): boolean {
  const semanticFinding = (finding: DiagnosticFinding): DiagnosticFinding => {
    const provenance = finding.evidence?.provenance;
    if (provenance === undefined) return finding;
    // A source's weekly fetch time advances even when its source URL, version,
    // and recommendation do not. The run-level watermark records that fresh
    // evaluation; treating the timestamp alone as a changed finding would
    // recreate every driver diagnostic and generate dead tuples every week.
    const { fetchedAt, ...sourceBasis } = provenance;
    void fetchedAt;
    return {
      ...finding,
      evidence: { ...finding.evidence, provenance: sourceBasis },
    };
  };
  return isDeepStrictEqual(stored.map(semanticFinding), recomputed.map(semanticFinding));
}

/** Replace only the two driver findings; every unrelated diagnostic survives. */
export async function applyDriverRefresh(
  runId: string,
  findings: readonly DiagnosticFinding[],
  changed: boolean,
  claim: Pick<ClaimedReprocessJob, "attempts">,
  db: Queryable = getPool(),
): Promise<void> {
  if (!changed) {
    // Preserve row identity and order, but refresh the source provenance and
    // last-evaluated timestamp. A current driver recommendation must not report
    // the date it was first established as if it were its latest evaluation.
    await db.query(
      `with job_claim as (
         select 1
           from reprocess_jobs
          where run_id = $1
            and kind = '${REPROCESS_KIND.driver}'
            and attempts = $2
            and locked_at is not null
            and failed_at is null
       ), run_update as (
         update runs
            set driver_evaluated_at = now()
          where id = $1
            and ${writableRunStatusSql()}
            and exists (select 1 from job_claim)
          returning id
       )
       update diagnostics diagnostic
          set evidence = refreshed.evidence::jsonb,
              evaluated_at = now()
         from unnest($3::text[], $4::text[]) as refreshed(code, evidence)
        where diagnostic.run_id = $1
          and diagnostic.code = refreshed.code
          and exists (select 1 from run_update)`,
      [
        runId,
        claim.attempts,
        findings.map((finding) => finding.code),
        findings.map((finding) => (finding.evidence ? JSON.stringify(finding.evidence) : null)),
      ],
    );
    return;
  }

  await db.query(
    `with job_claim as (
       select 1
         from reprocess_jobs
        where run_id = $1
          and kind = '${REPROCESS_KIND.driver}'
          and attempts = $2
          and locked_at is not null
          and failed_at is null
     ), run_update as (
       update runs
          set driver_evaluated_at = now()
        where id = $1
          and ${writableRunStatusSql()}
          and exists (select 1 from job_claim)
        returning id
     ), diagnostics_delete as (
       delete from diagnostics
        where run_id = $1
          and code = any($3::text[])
          and exists (select 1 from run_update)
     )
     ${diagnosticInsertSql(1, 4, "exists (select 1 from run_update)")}`,
    [
      runId,
      claim.attempts,
      DRIVER_RULE_CODES,
      ...diagnosticInsertColumns(findings),
    ],
  );
}
