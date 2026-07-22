/**
 * Moderation reports repo coverage (§20.5). Real Postgres via the shared
 * harness.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_STATUS, RUN_VISIBILITY, validRun } from "@heimdall/shared";
import type { Run } from "@heimdall/shared";
import { insertRun } from "../db";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { resolveGameId } from "./catalog";
import {
  createReport,
  hideRunForModeration,
  listOpenReports,
  ReportSubjectNotFoundError,
  updateReportStatus,
} from "./reports";

const canRun = testDbAvailable("reports.test");

function makeRun(id: string): Run {
  return {
    ...validRun,
    id,
    status: RUN_STATUS.pending,
    visibility: RUN_VISIBILITY.unlisted,
    framesObjectKey: undefined,
    signatureValid: undefined,
  };
}

describe.skipIf(!canRun)("moderation reports (§20.5)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  it("creates an anonymous run report and lists it as open", async () => {
    await insertRun(makeRun("run_report_anon"), db.pool);
    const report = await createReport(
      {
        subjectType: "run",
        subjectRunId: "run_report_anon",
        reason: "abusive-name",
        reporterUserId: null,
      },
      db.pool,
    );
    expect(report.status).toBe("open");
    expect(report.subjectRunId).toBe("run_report_anon");

    const open = await listOpenReports({}, db.pool);
    expect(open.reports.some((r) => r.id === report.id)).toBe(true);
  });

  it("creates a game report with a signed-in reporter and optional detail", async () => {
    await db.pool.query(
      "insert into users (id, role) values ($1, 'public') on conflict do nothing",
      ["user_reporter_1"],
    );
    const gameId = await resolveGameId("capframex", "Reportable Game", db.pool);
    if (!gameId) throw new Error("expected a resolvable game id");

    const report = await createReport(
      {
        subjectType: "game",
        subjectGameId: gameId,
        reason: "other",
        detail: "This game title looks wrong.",
        reporterUserId: "user_reporter_1",
      },
      db.pool,
    );
    expect(report.subjectGameId).toBe(gameId);
    expect(report.detail).toBe("This game title looks wrong.");
  });

  it("rejects a report whose run or game subject no longer exists", async () => {
    await expect(
      createReport(
        { subjectType: "run", subjectRunId: "run_report_missing", reason: "other", reporterUserId: null },
        db.pool,
      ),
    ).rejects.toBeInstanceOf(ReportSubjectNotFoundError);
  });

  it("treats runs hidden from the reporter as missing", async () => {
    const ownerId = "user_report_owner";
    await db.pool.query(
      "insert into users (id, role) values ($1, 'public') on conflict do nothing",
      [ownerId],
    );
    const inaccessibleRuns = [
      { id: "run_report_private", visibility: RUN_VISIBILITY.private, status: RUN_STATUS.pending },
      { id: "run_report_flagged", visibility: RUN_VISIBILITY.unlisted, status: RUN_STATUS.flagged },
      { id: "run_report_moderated", visibility: RUN_VISIBILITY.unlisted, status: RUN_STATUS.moderated },
      { id: "run_report_hidden", visibility: RUN_VISIBILITY.unlisted, status: RUN_STATUS.hidden },
    ] as const;
    for (const run of inaccessibleRuns) {
      await insertRun({ ...makeRun(run.id), ...run, ownerId }, db.pool);
      await expect(
        createReport(
          { subjectType: "run", subjectRunId: run.id, reason: "other", reporterUserId: null },
          db.pool,
        ),
      ).rejects.toBeInstanceOf(ReportSubjectNotFoundError);
    }

    // Owners may still report their visible private/flagged/moderated runs.
    await expect(
      createReport(
        {
          subjectType: "run",
          subjectRunId: "run_report_private",
          reason: "other",
          reporterUserId: ownerId,
        },
        db.pool,
      ),
    ).resolves.toMatchObject({ subjectRunId: "run_report_private" });
  });

  it("enforces subject-type consistency in Postgres, not only the request schema", async () => {
    await expect(
      db.pool.query(
        "insert into reports (subject_type, subject_game_id, reason) values ('run', 1, 'other')",
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "reports_subject_matches_type_check" });
  });

  it("seek-paginates the open-report admin queue", async () => {
    await insertRun(makeRun("run_report_page"), db.pool);
    await db.pool.query(
      `insert into reports (subject_type, subject_run_id, reason)
       select 'run', 'run_report_page', 'other'
         from generate_series(1, 120) value`,
    );

    const first = await listOpenReports({}, db.pool);
    expect(first.reports).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await listOpenReports({ cursor: first.nextCursor }, db.pool);
    expect(second.reports).toHaveLength(50);
    expect(new Set([...first.reports, ...second.reports].map((report) => report.id)).size).toBe(100);
  });

  it("dismiss transitions status and is idempotent (second call is a no-op false)", async () => {
    await insertRun(makeRun("run_report_dismiss"), db.pool);
    const report = await createReport(
      { subjectType: "run", subjectRunId: "run_report_dismiss", reason: "other", reporterUserId: null },
      db.pool,
    );

    await db.pool.query(
      "insert into users (id, role) values ($1, 'admin') on conflict do nothing",
      ["user_reports_admin"],
    );
    const first = await updateReportStatus(report.id, "dismissed", "user_reports_admin", db.pool);
    expect(first).toBe(true);
    const second = await updateReportStatus(report.id, "dismissed", "user_reports_admin", db.pool);
    expect(second).toBe(false);

    const open = await listOpenReports({}, db.pool);
    expect(open.reports.some((r) => r.id === report.id)).toBe(false);
  });

  it("hideRunForModeration moderates the run and resolves its open reports atomically", async () => {
    await insertRun(makeRun("run_report_hide"), db.pool);
    const first = await createReport(
      { subjectType: "run", subjectRunId: "run_report_hide", reason: "bad-faith-upload", reporterUserId: null },
      db.pool,
    );
    const second = await createReport(
      { subjectType: "run", subjectRunId: "run_report_hide", reason: "other", reporterUserId: null },
      db.pool,
    );

    await db.pool.query(
      "insert into users (id, role) values ($1, 'admin') on conflict do nothing",
      ["user_reports_admin_2"],
    );
    const moderated = await hideRunForModeration("run_report_hide", "user_reports_admin_2", db.pool);
    expect(moderated).toBe(true);

    const runRow = await db.pool.query("select status from runs where id = $1", ["run_report_hide"]);
    expect(runRow.rows[0]).toEqual({ status: "moderated" });

    const open = await listOpenReports({}, db.pool);
    expect(open.reports.some((r) => r.id === first.id || r.id === second.id)).toBe(false);
  });

  it("hideRunForModeration is a no-op against an already-moderated or hidden run", async () => {
    await insertRun(makeRun("run_report_already_moderated"), db.pool);
    await db.pool.query("update runs set status = 'moderated' where id = $1", [
      "run_report_already_moderated",
    ]);
    expect(
      await hideRunForModeration("run_report_already_moderated", "user_reports_admin_2", db.pool),
    ).toBe(false);

    await insertRun(makeRun("run_report_already_hidden"), db.pool);
    await db.pool.query("update runs set status = 'hidden' where id = $1", [
      "run_report_already_hidden",
    ]);
    expect(
      await hideRunForModeration("run_report_already_hidden", "user_reports_admin_2", db.pool),
    ).toBe(false);
  });

  it("leaves reports OPEN when the takedown changed no run", async () => {
    // The report update used to run unconditionally, so a call that moderated
    // nothing — and returned 404 to the moderator — still silently closed the
    // run's open reports, dropping them out of the queue forever.
    await insertRun(makeRun("run_report_noop"), db.pool);
    const report = await createReport(
      { subjectType: "run", subjectRunId: "run_report_noop", reason: "other", reporterUserId: null },
      db.pool,
    );
    await db.pool.query("update runs set status = 'hidden' where id = $1", ["run_report_noop"]);

    expect(
      await hideRunForModeration("run_report_noop", "user_reports_admin_2", db.pool),
    ).toBe(false);

    const open = await listOpenReports({}, db.pool);
    expect(open.reports.some((r) => r.id === report.id)).toBe(true);
  });

  it("updateReportStatus rejects a non-numeric id instead of erroring on the bigint cast", async () => {
    // `$1::bigint` on "not-a-number" raises `invalid input syntax`, which the
    // route surfaced as a 500 rather than the 404 it actually is.
    await expect(
      updateReportStatus("not-a-number", "dismissed", "user_reports_admin_2", db.pool),
    ).resolves.toBe(false);
  });
});
