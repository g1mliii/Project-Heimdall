/**
 * Pure PICS appinfo parsing (§8.8b).
 *
 * Every value Steam returns here is a STRING, including buildids, sizes and
 * manifest gids. Gids are 19 digits — `6967806384656644903` is larger than
 * Number.MAX_SAFE_INTEGER — so they are carried as strings end to end and cast
 * by Postgres, never by JavaScript. Nothing in this file calls Number() on a
 * gid or a size.
 *
 * Kept free of any Steam client so the whole shape can be tested against a
 * captured fixture without a network connection.
 */

export interface AppBuild {
  appid: number;
  branch: string;
  /** Decimal string; Postgres casts it to bigint. */
  buildid: string;
  timeUpdated: string | null;
  timeBuildUpdated: string | null;
  description: string | null;
  changenumber: number | null;
}

export interface AppDepot {
  appid: number;
  /** Decimal string; Postgres casts it to bigint. */
  depotId: string;
  name: string | null;
  maxSize: string | null;
  configOslist: string | null;
}

export interface DepotManifest {
  appid: number;
  depotId: string;
  branch: string;
  /** TEXT forever — see the file header. */
  manifestGid: string;
  sizeBytes: string | null;
  downloadBytes: string | null;
}

export interface ParsedApp {
  appid: number;
  name: string | null;
  appType: string | null;
  builds: AppBuild[];
  depots: AppDepot[];
  manifests: DepotManifest[];
}

const DECIMAL = /^[0-9]{1,20}$/;
const MAX_BRANCH_LENGTH = 128;
const MAX_TEXT_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A non-negative integer, kept as a string.
 *
 * PICS sends numbers as strings and occasionally as JSON numbers; both are
 * accepted, but the result is always a string so no caller can accidentally
 * widen a 19-digit gid through a float.
 */
export function decimalString(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return DECIMAL.test(trimmed) ? trimmed.replace(/^0+(?=\d)/, "") : null;
}

function boundedText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

/** Steam's unix-seconds strings to ISO, or null when absent/absurd. */
export function epochToIso(value: unknown): string | null {
  const seconds = decimalString(value);
  if (seconds === null) return null;
  const asNumber = Number(seconds);
  // Steam predates neither 1997 nor sanity; reject anything outside a plausible
  // window rather than storing a 1970 timestamp that looks like real data.
  if (!Number.isFinite(asNumber) || asNumber < 852_076_800 || asNumber > 4_102_444_800) {
    return null;
  }
  return new Date(asNumber * 1000).toISOString();
}

/**
 * `depots` mixes numeric depot ids with named configuration keys
 * (`branches`, `privatebranches`, `workshopdepot`, `baselanguages`, …), so a
 * depot is identified by its key being numeric — never by exclusion lists,
 * which would silently absorb any new key Valve adds.
 */
function isDepotKey(key: string): boolean {
  return DECIMAL.test(key);
}

export function parseProductInfo(
  appid: number,
  changenumber: number | null,
  appinfo: unknown,
): ParsedApp {
  const empty: ParsedApp = {
    appid,
    name: null,
    appType: null,
    builds: [],
    depots: [],
    manifests: [],
  };
  if (!isRecord(appinfo)) return empty;

  const common = isRecord(appinfo.common) ? appinfo.common : undefined;
  const name = boundedText(common?.name);
  // Steam is inconsistent about case here ("game" vs "Game"), so normalise.
  const appType = boundedText(common?.type, 64)?.toLowerCase() ?? null;

  // DLC, soundtracks and tools legitimately have no `depots` block at all.
  const depotsBlock = isRecord(appinfo.depots) ? appinfo.depots : undefined;
  if (!depotsBlock) return { ...empty, name, appType };

  const builds: AppBuild[] = [];
  const branchesBlock = isRecord(depotsBlock.branches) ? depotsBlock.branches : {};
  for (const [branchName, raw] of Object.entries(branchesBlock)) {
    const branch = boundedText(branchName, MAX_BRANCH_LENGTH);
    if (!branch || !isRecord(raw)) continue;
    const buildid = decimalString(raw.buildid);
    // A branch with no buildid is a password-gated placeholder, not a build.
    if (!buildid) continue;
    builds.push({
      appid,
      branch,
      buildid,
      timeUpdated: epochToIso(raw.timeupdated),
      timeBuildUpdated: epochToIso(raw.timebuildupdated),
      description: boundedText(raw.description),
      changenumber,
    });
  }

  const depots: AppDepot[] = [];
  const manifests: DepotManifest[] = [];
  for (const [key, raw] of Object.entries(depotsBlock)) {
    if (!isDepotKey(key) || !isRecord(raw)) continue;
    const depotId = decimalString(key);
    if (!depotId) continue;
    const config = isRecord(raw.config) ? raw.config : undefined;
    depots.push({
      appid,
      depotId,
      // System-defined depots carry no name; null is the honest value.
      name: boundedText(raw.name),
      maxSize: decimalString(raw.maxsize),
      configOslist: boundedText(config?.oslist, 64),
    });

    const manifestBlock = isRecord(raw.manifests) ? raw.manifests : {};
    for (const [branchName, entry] of Object.entries(manifestBlock)) {
      const branch = boundedText(branchName, MAX_BRANCH_LENGTH);
      if (!branch) continue;
      // Older appinfo used a bare gid string; newer uses {gid,size,download}.
      const gid = isRecord(entry) ? decimalString(entry.gid) : decimalString(entry);
      if (!gid) continue;
      manifests.push({
        appid,
        depotId,
        branch,
        manifestGid: gid,
        sizeBytes: isRecord(entry) ? decimalString(entry.size) : null,
        downloadBytes: isRecord(entry) ? decimalString(entry.download) : null,
      });
    }
  }

  return { appid, name, appType, builds, depots, manifests };
}
