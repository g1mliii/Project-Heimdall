import fallbackCsv from "../data/driver-fallback.csv";
import { compareDriverVersions } from "@heimdall/parsers";
import { normalizeAliasName } from "@heimdall/shared";

import { persistCuration } from "./db";
import { LIVE_DRIVER_SOURCES, parseFallbackCsv, type DriverSource } from "./sources";
import type {
  CurationBatch,
  CurationLogger,
  CurationReport,
  DriverCatalogRecord,
  GameRequirementCandidate,
  PersistReport,
  SourceBatch,
} from "./types";

const defaultLogger: CurationLogger = {
  info: (message, data) => console.info(message, data ?? {}),
  warn: (message, data) => console.warn(message, data ?? {}),
  error: (message, data) => console.error(message, data ?? {}),
};

function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "unknown source error";
  return `${error.name}: ${error.message}`.replace(
    /postgres(?:ql)?:\/\/[^\s]+/gi,
    "[redacted database URL]",
  );
}

function catalogKey(row: DriverCatalogRecord): string {
  return [row.vendor, row.os, row.component, row.gpuSeries ?? ""].join(":");
}

function requirementKey(row: GameRequirementCandidate): string {
  return [row.vendor, row.os, normalizeAliasName(row.title)].join(":");
}

/** The catalog tracks the newest driver a vendor shipped, so a later release wins. */
function preferNewer(
  previous: DriverCatalogRecord | undefined,
  incoming: DriverCatalogRecord,
): DriverCatalogRecord {
  if (!previous) return incoming;
  if (incoming.releasedAt !== previous.releasedAt) {
    return incoming.releasedAt > previous.releasedAt ? incoming : previous;
  }
  const versionComparison = compareDriverVersions(incoming.latestVersion, previous.latestVersion);
  if (versionComparison !== 0) return versionComparison > 0 ? incoming : previous;
  return incoming.fetchedAt >= previous.fetchedAt ? incoming : previous;
}

/**
 * `minVersion` is the OLDEST driver known to support a title, so an EARLIER
 * release wins — the mirror of the catalog rule, not an oversight.
 *
 * Vendors re-list already-supported titles in later notes (NVIDIA's "best
 * gaming experience for games including …" prose re-names flagship titles for
 * months after their Game Ready release). Taking the newest mention would
 * ratchet the requirement up to whatever driver shipped that week and tell a
 * user who captured on the title's actual Game Ready driver that theirs is too
 * old — again every week the title reappears.
 */
function preferEarlier(
  previous: GameRequirementCandidate | undefined,
  incoming: GameRequirementCandidate,
): GameRequirementCandidate {
  if (!previous) return incoming;
  if (incoming.releasedAt !== previous.releasedAt) {
    return incoming.releasedAt < previous.releasedAt ? incoming : previous;
  }
  const versionComparison = compareDriverVersions(incoming.minVersion, previous.minVersion);
  if (versionComparison !== 0) return versionComparison < 0 ? incoming : previous;
  return incoming.fetchedAt >= previous.fetchedAt ? incoming : previous;
}

export function mergeBatches(batches: readonly SourceBatch[]): CurationBatch {
  const catalog = new Map<string, DriverCatalogRecord>();
  const requirements = new Map<string, GameRequirementCandidate>();
  for (const batch of batches) {
    for (const row of batch.catalog) {
      const key = catalogKey(row);
      catalog.set(key, preferNewer(catalog.get(key), row));
    }
    for (const row of batch.requirements) {
      const key = requirementKey(row);
      requirements.set(key, preferEarlier(requirements.get(key), row));
    }
  }
  return { catalog: [...catalog.values()], requirements: [...requirements.values()] };
}

export interface CurateDeps {
  databaseUrl?: string;
  fetchImpl?: typeof fetch;
  fallback?: string;
  logger?: CurationLogger;
  now?: Date;
  persist?: (batch: CurationBatch) => Promise<PersistReport>;
  sources?: readonly DriverSource[];
}

export async function curateDrivers({
  databaseUrl,
  fetchImpl,
  fallback = fallbackCsv,
  logger = defaultLogger,
  now = new Date(),
  persist,
  sources = LIVE_DRIVER_SOURCES,
}: CurateDeps): Promise<CurationReport> {
  const fallbackBatch = parseFallbackCsv(fallback);
  const settled = await Promise.allSettled(
    sources.map(({ load }) => load({ fetchImpl, now })),
  );
  const successful: Array<{ name: string; batch: SourceBatch }> = [];
  const sourcesFailed: string[] = [];
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index]!;
    const source = sources[index]!.name;
    if (result.status === "fulfilled") {
      successful.push({ name: source, batch: result.value });
      logger.info("driver source ingested", {
        source,
        catalogRows: result.value.catalog.length,
        requirementRows: result.value.requirements.length,
        dropped: result.value.dropped,
      });
    } else {
      sourcesFailed.push(source);
      logger.warn("driver source failed; remaining sources continue", {
        source,
        error: errorSummary(result.reason),
      });
    }
  }

  // The checked-at timestamps in this file are intentionally preserved. A
  // fallback row therefore goes stale if maintainers stop refreshing it.
  const batch = mergeBatches([fallbackBatch, ...successful.map((item) => item.batch)]);
  const write =
    persist ??
    (databaseUrl
      ? (value: CurationBatch) => persistCuration(databaseUrl, value)
      : undefined);
  if (!write) throw new Error("databaseUrl or persist dependency is required");
  const persisted = await write(batch);
  const droppedBySources = successful.reduce((total, item) => total + item.batch.dropped, 0);
  if (persisted.unmatchedTitles.length > 0 || droppedBySources > 0) {
    logger.warn("driver curation dropped coverage", {
      unmatchedTitles: persisted.unmatchedTitles,
      sourceLimitDrops: droppedBySources,
    });
  }
  return {
    ...persisted,
    sourcesSucceeded: successful.map((item) => item.name),
    sourcesFailed,
    droppedBySources,
  };
}
