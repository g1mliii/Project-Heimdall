/**
 * Public game discovery read (§17.7).
 *
 * This is intentionally an individual-run listing, not an aggregate. The
 * canonical public + validated predicate protects unlisted submissions from
 * discovery, and every selected column is display-safe. In particular, run
 * signatures, anonymous management-token hashes, and user emails never enter
 * app memory on this path.
 */

import { isDriverOlderThan } from "@heimdall/parsers";
import type { DiagnosticsDriverPlatform } from "@heimdall/parsers";
import {
  aggregateEligibilitySql,
  GAME_SUBMISSIONS_MAX_PAGE_SIZE,
  isVerifiedReviewer,
  methodologyManifestSchema,
  missingComparabilityProfileFields,
} from "@heimdall/shared";
import type {
  GameSubmissionRow,
  GameSubmissionsPage,
  GameSubmissionsQuery,
  GeneratedFrameTech,
  GpuVendor,
  RayTracingMode,
  SceneType,
  SearchGameResult,
  UpscalerMode,
} from "@heimdall/shared";

import {
  DRIVER_CATALOG_MAX_AGE_DAYS,
  DRIVER_COMPONENT_SQL,
  DRIVER_PLATFORM_JOIN_SQL,
  DRIVER_UPDATE_GRACE_DAYS,
  getPool,
  query,
  REQUIRED_DRIVER_JOIN_SQL,
  REQUIRED_DRIVER_MAX_AGE_DAYS,
  type Queryable,
} from "../db";

interface GameSubmissionDbRow {
  game_id: string;
  game_slug: string;
  game_name: string;
  submission_id: string | null;
  created_at: Date | null;
  gpu: string | null;
  cpu: string | null;
  scene_type: SceneType | null;
  avg_fps: number | null;
  one_percent_low_fps: number | null;
  point_one_percent_low_fps: number | null;
  submitted_by: string | null;
  submitted_by_role: string | null;
  settings_json: unknown;
  methodology_manifest_version: number | null;
  resolution: string | null;
  graphics_api: string | null;
  upscaler: UpscalerMode | null;
  ray_tracing: RayTracingMode | null;
  generated_frame_tech: GeneratedFrameTech | null;
  is_warmup: boolean | null;
  benchmark_set_id: string | null;
  gpu_driver: string | null;
  gpu_vendor: GpuVendor | null;
  driver_os: DiagnosticsDriverPlatform["os"] | null;
  driver_component: DiagnosticsDriverPlatform["component"] | null;
  required_driver: string | null;
  latest_driver: string | null;
}

interface DecodedCursor {
  createdAt: string;
  id: string;
}

export interface GamePageRead {
  game: SearchGameResult;
  submissions: GameSubmissionsPage;
}

export class InvalidGameSubmissionsCursorError extends Error {
  constructor() {
    super("invalid game submissions cursor");
    this.name = "InvalidGameSubmissionsCursorError";
  }
}

function encodeCursor(row: GameSubmissionRow): string {
  return Buffer.from(`${row.createdAt}|${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): DecodedCursor | null {
  if (cursor === undefined) return null;

  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.indexOf("|");
    if (separator <= 0 || separator === decoded.length - 1) {
      throw new InvalidGameSubmissionsCursorError();
    }

    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    const parsedDate = new Date(createdAt);
    if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString() !== createdAt) {
      throw new InvalidGameSubmissionsCursorError();
    }
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) {
      throw new InvalidGameSubmissionsCursorError();
    }
    return { createdAt, id };
  } catch {
    // Every failure path — malformed base64url, bad separator, non-canonical
    // date, or a non-round-tripping re-encode — is the same invalid cursor.
    throw new InvalidGameSubmissionsCursorError();
  }
}

/**
 * Server-side driver-currency flags for one submission. Delegates the
 * normalize-then-compare decision to {@link isDriverOlderThan} — the same
 * primitive the diagnostics rules use, so the badge and the diagnostic cannot
 * disagree. Self-suppresses (both false) when the driver, vendor, or resolved
 * platform is absent, exactly as the diagnostics rules no-op.
 */
function driverCurrency(row: GameSubmissionDbRow): {
  belowMinimum: boolean;
  behindLatest: boolean;
} {
  const { gpu_driver: driver, gpu_vendor: vendor, driver_os: os, driver_component: component } = row;
  if (!driver || !vendor || vendor === "unknown" || !os || !component) {
    return { belowMinimum: false, behindLatest: false };
  }
  return {
    belowMinimum:
      row.required_driver !== null &&
      isDriverOlderThan(driver, row.required_driver, vendor, os, component),
    behindLatest:
      row.latest_driver !== null &&
      isDriverOlderThan(driver, row.latest_driver, vendor, os, component),
  };
}

/**
 * Map one populated `run_page` row to a submission. The caller filters the
 * no-runs sentinel (see {@link readGamePage}), so every row reaching here is a
 * real submission whose NOT-NULL / inner-joined columns are present.
 */
function mapSubmission(row: GameSubmissionDbRow): GameSubmissionRow {
  const { belowMinimum, behindLatest } = driverCurrency(row);
  const parsedMethodology =
    row.methodology_manifest_version === null
      ? null
      : methodologyManifestSchema.safeParse(row.settings_json);
  const profileComplete =
    parsedMethodology !== null &&
    parsedMethodology.success &&
    missingComparabilityProfileFields(parsedMethodology.data).length === 0;

  return {
    id: row.submission_id!,
    createdAt: row.created_at!.toISOString(),
    gpu: row.gpu!,
    cpu: row.cpu!,
    sceneType: row.scene_type,
    avgFps: row.avg_fps!,
    onePercentLowFps: row.one_percent_low_fps!,
    pointOnePercentLowFps: row.point_one_percent_low_fps!,
    submittedBy: row.submitted_by,
    submittedByVerified: isVerifiedReviewer(row.submitted_by_role),
    methodology: {
      profileComplete,
      resolution: row.resolution,
      graphicsApi: row.graphics_api,
      upscaler: row.upscaler,
      rayTracing: row.ray_tracing,
      frameGeneration: row.generated_frame_tech!,
    },
    isWarmup: row.is_warmup ?? false,
    benchmarkSetId: row.benchmark_set_id,
    driverBelowMinimum: belowMinimum,
    driverBehindLatest: behindLatest,
  };
}

/**
 * `PATCH /api/admin/games/:id` (§20.5) — admin display-name fix on an existing
 * row; cross-id rename-MERGE is explicitly deferred.
 *
 * The id-shape guard belongs here, not at the route: `$1::bigint` on "abc"
 * raises `invalid input syntax`, which the caller would surface as a 500
 * rather than the 404 it is (same reasoning as `isReportId` in repo/reports.ts).
 */
export async function renameGame(
  id: string,
  name: string,
  db: Queryable = getPool(),
): Promise<boolean> {
  if (!/^\d+$/.test(id)) {
    return false;
  }
  const result = await db.query("update games set name = $2 where id = $1::bigint", [id, name]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Read one bounded page plus the canonical game identity in a single query.
 * There is deliberately no total-count query: the eventual comparable-cohort
 * count has different semantics, and an unbounded count adds request-path work.
 */
export async function readGamePage(
  slug: string,
  options: GameSubmissionsQuery,
  db: Queryable = getPool(),
): Promise<GamePageRead | null> {
  const cursor = decodeCursor(options.cursor);
  const limit = Math.min(options.limit, GAME_SUBMISSIONS_MAX_PAGE_SIZE);
  const sortDirection = options.sortDirection ?? "desc";
  // These fragments are selected from a closed shared-schema enum, never
  // interpolated from an unchecked request value.
  const cursorOperator = sortDirection === "asc" ? ">" : "<";
  const orderDirection = sortDirection === "asc" ? "asc" : "desc";
  const rows = await query<GameSubmissionDbRow>(
    `with selected_game as (
       select g.id, g.slug, g.name
         from games g
        where g.slug = $1
     ), run_page as (
       select r.id as submission_id,
              r.created_at,
              coalesce(gpu.canonical_name, r.gpu_model) as gpu,
              coalesce(cpu.canonical_name, r.cpu_model) as cpu,
              r.scene_type,
              s.avg_fps,
              s.p1_low_fps as one_percent_low_fps,
              s.p01_low_fps as point_one_percent_low_fps,
              u.handle as submitted_by,
              u.role as submitted_by_role,
              r.settings_json,
              r.methodology_manifest_version,
              r.resolution,
              r.graphics_api,
              r.upscaler,
              r.ray_tracing,
              r.generated_frame_tech,
              r.is_warmup,
              r.benchmark_set_id,
              r.gpu_driver,
              r.gpu_vendor,
              driver_platform.os as driver_os,
              ${DRIVER_COMPONENT_SQL} as driver_component,
              requirement.min_version as required_driver,
              catalog.latest_version as latest_driver
         from selected_game game
         join runs r on r.game_id = game.id
         join run_summaries s on s.run_id = r.id
         left join hardware gpu
           on gpu.id = r.gpu_hardware_id and gpu.kind = 'gpu'
         left join hardware cpu
           on cpu.id = r.cpu_hardware_id and cpu.kind = 'cpu'
         left join users u on u.id = r.user_id
         ${DRIVER_PLATFORM_JOIN_SQL}
         ${REQUIRED_DRIVER_JOIN_SQL}
         left join driver_catalog catalog
           on catalog.vendor = r.gpu_vendor
          and catalog.os = driver_platform.os
          and catalog.component = ${DRIVER_COMPONENT_SQL}
          and catalog.gpu_series_key = ''
          and catalog.fetched_at >= now() - ($3::integer * interval '1 day')
          and catalog.released_at <= current_date - $4::integer
        where ${aggregateEligibilitySql("r")}
          and ($5::timestamptz is null or (r.created_at, r.id) ${cursorOperator} ($5::timestamptz, $6::text))
          and ($7::text is null or r.scene_type = $7::text)
        order by r.created_at ${orderDirection}, r.id ${orderDirection}
        limit $8
     )
     select game.id::text as game_id,
            game.slug as game_slug,
            game.name as game_name,
            page.submission_id,
            page.created_at,
            page.gpu,
            page.cpu,
            page.scene_type,
            page.avg_fps,
            page.one_percent_low_fps,
            page.point_one_percent_low_fps,
            page.submitted_by,
            page.submitted_by_role,
            page.settings_json,
            page.methodology_manifest_version,
            page.resolution,
            page.graphics_api,
            page.upscaler,
            page.ray_tracing,
            page.generated_frame_tech,
            page.is_warmup,
            page.benchmark_set_id,
            page.gpu_driver,
            page.gpu_vendor,
            page.driver_os,
            page.driver_component,
            page.required_driver,
            page.latest_driver
       from selected_game game
       left join run_page page on true
      order by page.created_at ${orderDirection}, page.submission_id ${orderDirection}`,
    [
      slug,
      REQUIRED_DRIVER_MAX_AGE_DAYS,
      DRIVER_CATALOG_MAX_AGE_DAYS,
      DRIVER_UPDATE_GRACE_DAYS,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      options.sceneType ?? null,
      limit + 1,
    ],
    db,
  );

  const first = rows[0];
  if (!first) return null;

  // `selected_game left join run_page on true` returns a single all-null
  // sentinel row when the game has no eligible runs, and fully-populated rows
  // otherwise — never a mix. So one submission_id check on the first row
  // decides the empty case; the rest are guaranteed real submissions.
  const mapped = first.submission_id === null ? [] : rows.map(mapSubmission);
  const hasNextPage = mapped.length > limit;
  const pageRows = hasNextPage ? mapped.slice(0, limit) : mapped;
  return {
    game: { id: first.game_id, slug: first.game_slug, name: first.game_name },
    submissions: {
      rows: pageRows,
      nextCursor: hasNextPage ? encodeCursor(pageRows[pageRows.length - 1]!) : null,
    },
  };
}
