/**
 * Moderation reports (§20.5). Anonymous-allowed create; the reporter is also
 * the current viewer for the run visibility gate. Admin-only read/resolve.
 */

import { getPool, query, type Queryable } from "../db";
import { RUN_STATUS, RUN_VISIBILITY, writableRunStatusSql } from "@heimdall/shared";
import type { CreateReportRequest, ReportRow } from "@heimdall/shared";

export type CreateReportInput = CreateReportRequest & { reporterUserId: string | null };

export class ReportSubjectNotFoundError extends Error {
  constructor() {
    super("report subject not found");
    this.name = "ReportSubjectNotFoundError";
  }
}

interface ReportDbRow {
  id: string;
  subject_type: "run" | "game";
  subject_run_id: string | null;
  subject_game_id: string | null;
  reason: ReportRow["reason"];
  detail: string | null;
  status: ReportRow["status"];
  created_at: string;
}

function toReportRow(row: ReportDbRow): ReportRow {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectRunId: row.subject_run_id,
    subjectGameId: row.subject_game_id,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function createReport(
  input: CreateReportInput,
  db: Queryable = getPool(),
): Promise<ReportRow> {
  const rows = await query<ReportDbRow>(
    `insert into reports (
       subject_type, subject_run_id, subject_game_id, reason, detail, reporter_user_id
     )
     select $1, $2, $3::bigint, $4, $5, $6
     where ($1 = 'run' and exists (
             select 1
               from runs r
              where r.id = $2
                and r.status <> '${RUN_STATUS.hidden}'
                and (
                  r.user_id = $6::text
                  or (
                    r.visibility <> '${RUN_VISIBILITY.private}'
                    and r.status not in ('${RUN_STATUS.flagged}', '${RUN_STATUS.moderated}')
                  )
                )
           ))
         or ($1 = 'game' and exists (select 1 from games where id = $3::bigint))
     returning id::text, subject_type, subject_run_id, subject_game_id::text, reason, detail, status,
               created_at::text as created_at`,
    [
      input.subjectType,
      input.subjectRunId ?? null,
      input.subjectGameId ?? null,
      input.reason,
      input.detail ?? null,
      input.reporterUserId,
    ],
    db,
  );
  const row = rows[0];
  if (!row) throw new ReportSubjectNotFoundError();
  return toReportRow(row);
}

/** Admin queue: bounded, seek-paginated newest-first reads over `reports_open_idx`. */
const OPEN_REPORTS_PAGE_SIZE = 50;

export interface OpenReportsPage {
  reports: ReportRow[];
  nextCursor: string | null;
}

export class InvalidOpenReportsCursorError extends Error {
  constructor() {
    super("invalid open reports cursor");
    this.name = "InvalidOpenReportsCursorError";
  }
}

interface OpenReportsCursor {
  createdAt: string;
  id: string;
}

function encodeOpenReportsCursor(row: Pick<ReportDbRow, "created_at" | "id">): string {
  // PostgreSQL retains microseconds while JavaScript Date only retains
  // milliseconds. Preserve the database text exactly or reports created in
  // the cursor's millisecond can be skipped on the next page.
  return Buffer.from(JSON.stringify([row.created_at, row.id]), "utf8").toString("base64url");
}

function decodeOpenReportsCursor(cursor: string | null | undefined): OpenReportsCursor | null {
  if (cursor === null || cursor === undefined) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      Number.isNaN(Date.parse(value[0])) ||
      typeof value[1] !== "string" ||
      !/^\d+$/.test(value[1])
    ) {
      throw new Error("invalid cursor shape");
    }
    return { createdAt: value[0], id: value[1] };
  } catch {
    throw new InvalidOpenReportsCursorError();
  }
}

export async function listOpenReports(
  { cursor, limit = OPEN_REPORTS_PAGE_SIZE }: { cursor?: string | null; limit?: number } = {},
  db: Queryable = getPool(),
): Promise<OpenReportsPage> {
  const decoded = decodeOpenReportsCursor(cursor);
  const pageSize = Math.max(1, Math.min(limit, OPEN_REPORTS_PAGE_SIZE));
  const rows = await query<ReportDbRow>(
    `select id::text, subject_type, subject_run_id, subject_game_id::text, reason, detail, status,
            created_at::text as created_at
      from reports
      where status = 'open'
        and (
          $1::timestamptz is null
          or (reports.created_at, reports.id) < ($1::timestamptz, $2::bigint)
        )
      order by reports.created_at desc, reports.id desc
      limit $3`,
    [decoded?.createdAt ?? null, decoded?.id ?? null, pageSize + 1],
    db,
  );
  const page = rows.slice(0, pageSize);
  const last = page.at(-1);
  return {
    reports: page.map(toReportRow),
    nextCursor: rows.length > pageSize && last ? encodeOpenReportsCursor(last) : null,
  };
}

/**
 * `PATCH /api/admin/reports/:id` — resolve or dismiss; idempotent (a second
 * call is a no-op false). Non-numeric ids are rejected before they reach
 * Postgres: `$1::bigint` on "abc" raises `invalid input syntax`, which the
 * route would surface as a 500 rather than the 404 it is.
 */
export async function updateReportStatus(
  id: string,
  status: "resolved" | "dismissed",
  resolvedBy: string,
  db: Queryable = getPool(),
): Promise<boolean> {
  if (!isReportId(id)) {
    return false;
  }
  const result = await db.query(
    `update reports
        set status = $2, resolved_at = now(), resolved_by = $3
      where id = $1::bigint and status = 'open'`,
    [id, status, resolvedBy],
  );
  return (result.rowCount ?? 0) > 0;
}

/** `reports.id` is `bigint generated always as identity` — decimal digits only. */
function isReportId(id: string): boolean {
  return /^\d+$/.test(id);
}

/**
 * Moderation takedown: hide a run and resolve its open reports.
 *
 * ONE data-modifying statement, not two round trips: the report update is
 * gated on `exists (select 1 from run_update)` (same CTE-gating idiom as
 * `applyVerificationResult` in repo/jobs.ts), so the two can neither drift
 * apart on a mid-sequence failure nor — the actual bug this replaced — close
 * a run's open reports on a call that changed no run at all and returned 404
 * to the moderator.
 */
export async function hideRunForModeration(
  runId: string,
  resolvedBy: string,
  db: Queryable = getPool(),
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `with run_update as (
       update runs set status = '${RUN_STATUS.moderated}'
        where id = $1
          and ${writableRunStatusSql()}
       returning id
     ), report_update as (
       update reports
          set status = 'resolved', resolved_at = now(), resolved_by = $2
        where subject_type = 'run'
          and subject_run_id = $1
          and status = 'open'
          and exists (select 1 from run_update)
       returning id
     )
     select id from run_update`,
    [runId, resolvedBy],
    db,
  );
  return rows.length > 0;
}
