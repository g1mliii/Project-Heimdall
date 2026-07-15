import { compareDriverVersions, normalizeDriverVersion, splitCsvLine } from "@heimdall/parsers";
import { cleanDisplayName, normalizeAliasName } from "@heimdall/shared";

import { fetchText } from "./fetch";
import type {
  DriverCatalogRecord,
  DriverVendor,
  GameRequirementCandidate,
  SourceBatch,
} from "./types";

const CHANGELOG_AMD_LIMIT = 25;

export const SOURCE_URLS = {
  nvidiaWindows:
    "https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=120&pfid=942&osID=57&languageCode=1033&beta=0&isWHQL=1&dltype=-1&dch=1&upCRD=0&qnf=0&ctk=null&sort1=1&numberOfResults=1",
  nvidiaLinuxLatest: "https://download.nvidia.com/XFree86/Linux-x86_64/latest.txt",
  amdIndex:
    "https://www.amd.com/en/resources/support-articles/release-notes/rn-rad-win-vulkan.html",
  amdChangelog:
    `https://changelog.gg/api/v1/entities/driver/amd-radeon-adrenalin-driver/records?limit=${CHANGELOG_AMD_LIMIT}`,
  intelWindows:
    "https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html",
  mesaIndex: "https://docs.mesa3d.org/relnotes.html",
} as const;

const MAX_REQUIREMENTS_PER_SOURCE = 100;
const VERSION = /^\d+(?:\.\d+){1,4}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NAMED_MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function validVersion(
  value: string,
  vendor: DriverVendor,
  os: "windows" | "linux",
  component: "gpu" | "mesa",
): string {
  const normalized = normalizeDriverVersion(value, vendor, os, component);
  if (!normalized || normalized.length > 32 || !VERSION.test(normalized)) {
    throw new Error(`invalid ${vendor}/${os} driver version`);
  }
  return normalized;
}

function isoDate(value: string): string {
  const cleaned = value
    .replace(/(\d+)(st|nd|rd|th)/gi, "$1")
    .replace(/^(?:mon|tue|wed|thu|fri|sat|sun)\.?,?\s+/i, "")
    .replace(/\.$/, "")
    .trim();
  let parts: readonly [year: number, month: number, day: number] | undefined;
  const iso = cleaned.match(/^(?<year>\d{4})-(?<month>\d{1,2})-(?<day>\d{1,2})$/);
  const numeric = cleaned.match(/^(?<month>\d{1,2})\/(?<day>\d{1,2})\/(?<year>\d{4})$/);
  const named = cleaned.match(/^(?<month>[a-z]+)\s+(?<day>\d{1,2}),\s*(?<year>\d{4})$/i);
  if (iso?.groups) {
    parts = [Number(iso.groups.year), Number(iso.groups.month), Number(iso.groups.day)];
  } else if (numeric?.groups) {
    parts = [
      Number(numeric.groups.year),
      Number(numeric.groups.month),
      Number(numeric.groups.day),
    ];
  } else if (named?.groups) {
    const namedMonth = named.groups.month;
    const month = namedMonth === undefined ? undefined : NAMED_MONTHS[namedMonth.toLowerCase()];
    if (month !== undefined) {
      parts = [Number(named.groups.year), month, Number(named.groups.day)];
    }
  }
  if (parts === undefined || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`invalid release date: ${value}`);
  }
  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`invalid release date: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    mdash: "—",
    ndash: "–",
    nbsp: " ",
    quot: '"',
    lsquo: "'",
    reg: "",
    rsquo: "'",
    trade: "",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith("#")) {
      const hexadecimal = body[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

function safePercentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function htmlLines(value: string): string[] {
  return decodeEntities(safePercentDecode(value))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(?:br|\/p|\/li|\/h[1-6]|\/div|\/section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function title(value: string): string | null {
  const cleaned = cleanDisplayName(
    decodeEntities(value)
    .replace(/^[\s*•·–—-]+/, "")
    .replace(/[*]+/g, "")
    .replace(/[.;]+$/, "")
    .trim(),
  );
  if (cleaned.length < 2 || cleaned.length > 160 || !/[\p{L}\p{N}]/u.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function uniqueTitles(values: readonly string[]): string[] {
  const titles = new Map<string, string>();
  for (const value of values) {
    const cleaned = title(value);
    if (cleaned) titles.set(normalizeAliasName(cleaned), cleaned);
  }
  return [...titles.values()];
}

function splitTitleList(value: string, splitListConjunction = false): string[] {
  const separator = splitListConjunction
    ? /\s*,\s*(?:and\s+)?|\s+and\s+(?=[A-Z0-9])/i
    : /\s*,\s*(?:and\s+)?/i;
  return value
    .replace(/^.*?including\s+/i, "")
    // Only NVIDIA's explicit plural "games including" prose supports a
    // list-style conjunction. A Game Ready title can legitimately contain
    // "and" (for example, Indiana Jones and the Great Circle).
    .split(separator)
    .map((part) => part.trim());
}

function boundedRequirements(
  vendor: DriverVendor,
  version: string,
  releasedAt: string,
  sourceUrl: string,
  fetchedAt: string,
  titles: readonly string[],
): Pick<SourceBatch, "requirements" | "dropped"> {
  const values = uniqueTitles(titles);
  const accepted = values.slice(0, MAX_REQUIREMENTS_PER_SOURCE);
  return {
    requirements: accepted.map((gameTitle) => ({
      vendor,
      os: "windows",
      minVersion: version,
      title: gameTitle,
      releasedAt,
      sourceUrl,
      fetchedAt,
    })),
    dropped: Math.max(0, values.length - accepted.length),
  };
}

interface NvidiaLookup {
  Success?: string;
  IDS?: Array<{
    downloadInfo?: {
      Version?: string;
      ReleaseDateTime?: string;
      DetailsURL?: string;
      ReleaseNotes?: string;
    };
  }>;
}

export function parseNvidiaLookup(
  raw: string,
  os: "windows" | "linux",
  fetchedAt: string,
): SourceBatch {
  const parsed = JSON.parse(raw) as NvidiaLookup;
  const info = parsed.IDS?.[0]?.downloadInfo;
  if (parsed.Success !== "1" || !info?.Version || !info.ReleaseDateTime || !info.DetailsURL) {
    throw new Error(`NVIDIA ${os} response did not contain one driver`);
  }
  const latestVersion = validVersion(info.Version, "nvidia", os, "gpu");
  const releasedAt = isoDate(info.ReleaseDateTime);
  const source = new URL(info.DetailsURL);
  if (source.protocol !== "https:" || source.hostname !== "www.nvidia.com") {
    throw new Error("NVIDIA details URL left the vendor host");
  }

  const notes = os === "windows" ? htmlLines(info.ReleaseNotes ?? "") : [];
  const gameTitles: string[] = [];
  for (const line of notes) {
    if (/^Game Ready for\s+/i.test(line)) {
      gameTitles.push(...splitTitleList(line.replace(/^Game Ready for\s+/i, "")));
    } else if (/\bincluding\b/i.test(line) && /gaming experience/i.test(line)) {
      gameTitles.push(...splitTitleList(line, /\bgames\s+including\b/i.test(line)));
    }
  }
  const requirementBatch = boundedRequirements(
    "nvidia",
    latestVersion,
    releasedAt,
    source.href,
    fetchedAt,
    gameTitles,
  );
  return {
    catalog: [
      {
        vendor: "nvidia",
        os,
        component: "gpu",
        latestVersion,
        releasedAt,
        sourceUrl: source.href,
        fetchedAt,
      },
    ],
    requirements: os === "windows" ? requirementBatch.requirements : [],
    dropped: os === "windows" ? requirementBatch.dropped : 0,
  };
}

export function parseNvidiaLinuxPointer(latestRaw: string): {
  version: string;
  detailsUrl: string;
} {
  const latest = latestRaw.trim().match(/^(\d+(?:\.\d+){1,2})\s+(\S+)$/);
  if (!latest?.[1] || !latest[2]) throw new Error("NVIDIA Linux latest shape changed");
  const version = validVersion(latest[1], "nvidia", "linux", "gpu");
  const expectedPath = `${version}/NVIDIA-Linux-x86_64-${version}.run`;
  if (latest[2] !== expectedPath) throw new Error("NVIDIA Linux latest path changed");
  return {
    version,
    detailsUrl: `https://download.nvidia.com/XFree86/Linux-x86_64/${version}/`,
  };
}

export function parseNvidiaLinuxLatest(
  latestRaw: string,
  detailsRaw: string,
  fetchedAt: string,
): SourceBatch {
  const { version, detailsUrl } = parseNvidiaLinuxPointer(latestRaw);
  const escapedVersion = version.replaceAll(".", "\\.");
  const releasedAt = detailsRaw.match(
    new RegExp(
      `NVIDIA-Linux-x86_64-${escapedVersion}\\.run[\\s\\S]{0,250}<span class=['"]date['"]>(\\d{4}-\\d{2}-\\d{2})`,
      "i",
    ),
  )?.[1];
  if (!releasedAt || !ISO_DATE.test(releasedAt)) {
    throw new Error("NVIDIA Linux details shape changed");
  }
  return {
    catalog: [
      {
        vendor: "nvidia",
        os: "linux",
        component: "gpu",
        latestVersion: version,
        releasedAt,
        sourceUrl: detailsUrl,
        fetchedAt,
      },
    ],
    requirements: [],
    dropped: 0,
  };
}

export function parseAmdIndex(raw: string): string {
  const match = raw.match(
    /href=["']((?:https:\/\/www\.amd\.com)?\/en\/resources\/support-articles\/release-notes\/RN-RAD-WIN-\d+-\d+-\d+\.html)["']/i,
  );
  if (!match?.[1]) throw new Error("AMD index had no current Adrenalin release-note link");
  const source = new URL(match[1], "https://www.amd.com");
  if (source.protocol !== "https:" || source.hostname !== "www.amd.com") {
    throw new Error("AMD release-note link left the vendor host");
  }
  const versionParts = source.pathname.match(/RN-RAD-WIN-(\d+)-(\d+)-(\d+)\.html$/i);
  const version = versionParts?.slice(1).join(".");
  const validated = version ? amdReleaseNotesUrl(source.href, version) : null;
  if (!validated) throw new Error("AMD release-note link was not canonical");
  return validated;
}

function jsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalAmdUrl(value: string, acceptsPath: (pathname: string) => boolean): URL | null {
  let source: URL;
  try {
    source = new URL(value);
  } catch {
    return null;
  }
  if (
    source.origin !== "https://www.amd.com" ||
    source.username !== "" ||
    source.password !== "" ||
    source.search !== "" ||
    source.hash !== "" ||
    !acceptsPath(source.pathname)
  ) {
    return null;
  }
  return source;
}

function amdReleaseNotesUrl(value: string, version: string): string | null {
  const expectedPath = `/en/resources/support-articles/release-notes/RN-RAD-WIN-${version.replaceAll(".", "-")}.html`;
  return (
    canonicalAmdUrl(
      value,
      (pathname) => pathname.toLowerCase() === expectedPath.toLowerCase(),
    )?.href ?? null
  );
}

function amdDriverPageUrl(value: string): string | null {
  return (
    canonicalAmdUrl(
      value,
      (pathname) => pathname.startsWith("/en/support/downloads/drivers.html/graphics/"),
    )?.href ?? null
  );
}

export interface AmdChangelogDiscovery {
  detailsUrl: string;
  releasedAt: string;
  verificationUrl: string;
  version: string;
}

/** Parse Changelog.gg as discovery metadata; it is never persisted directly. */
export function parseAmdChangelog(
  raw: string,
  fetchedAt: string,
): AmdChangelogDiscovery {
  const parsed: unknown = JSON.parse(raw);
  if (!jsonObject(parsed) || parsed.ok !== true || !jsonObject(parsed.data)) {
    throw new Error("Changelog.gg AMD response shape changed");
  }
  const records = parsed.data.records;
  if (!Array.isArray(records)) throw new Error("Changelog.gg AMD records were missing");
  if (records.length > CHANGELOG_AMD_LIMIT) {
    throw new Error("Changelog.gg AMD records exceeded the bounded page");
  }
  const fetchedDate = fetchedAt.slice(0, 10);
  let latest: AmdChangelogDiscovery | undefined;

  for (const record of records) {
    if (!jsonObject(record) || !jsonObject(record.driverUpdate)) continue;
    const update = record.driverUpdate;
    if (
      record.channel !== "stable" ||
      record.updateType !== "release" ||
      update.vendor !== "amd" ||
      update.channel !== "adrenalin" ||
      typeof record.version !== "string" ||
      !VERSION.test(record.version) ||
      update.version !== record.version ||
      typeof record.publishedAt !== "string" ||
      update.releaseDate !== record.publishedAt ||
      !ISO_DATE.test(record.publishedAt) ||
      record.publishedAt > fetchedDate ||
      typeof record.sourceUrl !== "string" ||
      update.releaseNotesUrl !== record.sourceUrl ||
      typeof update.sourceUrl !== "string"
    ) {
      continue;
    }
    let releasedAt: string;
    try {
      releasedAt = isoDate(record.publishedAt);
    } catch {
      continue;
    }
    if (releasedAt !== record.publishedAt) continue;
    let latestVersion: string;
    try {
      latestVersion = validVersion(record.version, "amd", "windows", "gpu");
    } catch {
      continue;
    }
    if (latestVersion !== record.version) continue;
    const sourceUrl = amdReleaseNotesUrl(record.sourceUrl, latestVersion);
    const verificationUrl = amdDriverPageUrl(update.sourceUrl);
    if (!sourceUrl || !verificationUrl) continue;
    const candidate: AmdChangelogDiscovery = {
      detailsUrl: sourceUrl,
      releasedAt,
      verificationUrl,
      version: latestVersion,
    };
    if (
      !latest ||
      candidate.releasedAt > latest.releasedAt ||
      (candidate.releasedAt === latest.releasedAt &&
        compareDriverVersions(candidate.version, latest.version) > 0)
    ) {
      latest = candidate;
    }
  }

  if (!latest) throw new Error("Changelog.gg AMD response had no valid stable release");
  return latest;
}

export function parseAmdDriverPage(raw: string, fetchedAt: string): SourceBatch {
  const lines = htmlLines(raw);
  const detailsUrl = parseAmdIndex(raw);
  let latest: DriverCatalogRecord | undefined;
  for (let index = 0; index < lines.length; index++) {
    if (!/^AMD Software:\s*Adrenalin Edition$/i.test(lines[index]!)) continue;
    const window = lines.slice(index + 1, index + 16);
    const versionValue = window
      .map((line) => line.match(/^Adrenalin\s+(\d+(?:\.\d+){2})\b/i)?.[1])
      .find(Boolean);
    const dateIndex = window.findIndex((line) => /^Release Date$/i.test(line));
    const dateValue = dateIndex >= 0 ? window[dateIndex + 1] : undefined;
    if (!versionValue || !dateValue || !ISO_DATE.test(dateValue)) continue;
    let latestVersion: string;
    let releasedAt: string;
    try {
      latestVersion = validVersion(versionValue, "amd", "windows", "gpu");
      releasedAt = isoDate(dateValue);
    } catch {
      continue;
    }
    if (releasedAt !== dateValue || !amdReleaseNotesUrl(detailsUrl, latestVersion)) continue;
    const candidate: DriverCatalogRecord = {
      vendor: "amd",
      os: "windows",
      component: "gpu",
      latestVersion,
      releasedAt,
      sourceUrl: detailsUrl,
      fetchedAt,
    };
    if (
      !latest ||
      candidate.releasedAt > latest.releasedAt ||
      (candidate.releasedAt === latest.releasedAt &&
        compareDriverVersions(candidate.latestVersion, latest.latestVersion) > 0)
    ) {
      latest = candidate;
    }
  }
  if (!latest) throw new Error("AMD driver page shape changed");
  return { catalog: [latest], requirements: [], dropped: 0 };
}

function sectionItems(
  lines: readonly string[],
  start: RegExp,
  stops: readonly RegExp[],
): string[] {
  const startIndex = lines.findIndex((line) => start.test(line));
  if (startIndex === -1) return [];
  const values: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (stops.some((stop) => stop.test(line))) break;
    values.push(line);
  }
  return values;
}

export function parseAmdReleaseNotes(
  raw: string,
  fetchedAt: string,
  sourceUrl: string,
): SourceBatch {
  const lines = htmlLines(raw);
  const joined = lines.join("\n");
  const versionMatch = joined.match(/AMD Software:\s*Adrenalin Edition\s+(\d+(?:\.\d+){2})/i);
  const dateMatch = joined.match(/Last Updated:\s*([^\n]+)/i);
  if (!versionMatch?.[1] || !dateMatch?.[1]) throw new Error("AMD release shape changed");
  const latestVersion = validVersion(versionMatch[1], "amd", "windows", "gpu");
  const canonicalSourceUrl = amdReleaseNotesUrl(sourceUrl, latestVersion);
  if (!canonicalSourceUrl) throw new Error("AMD release-note URL did not match parsed version");
  const releasedAt = isoDate(dateMatch[1]);
  const games = sectionItems(lines, /^New Game Support$/i, [
    /^Fixed Issues:?$/i,
    /^Known Issues:?$/i,
    /^New Product Support:?$/i,
  ]);
  const requirementBatch = boundedRequirements(
    "amd",
    latestVersion,
    releasedAt,
    canonicalSourceUrl,
    fetchedAt,
    games,
  );
  return {
    catalog: [
      {
        vendor: "amd",
        os: "windows",
        component: "gpu",
        latestVersion,
        releasedAt,
        sourceUrl: canonicalSourceUrl,
        fetchedAt,
      },
    ],
    ...requirementBatch,
  };
}

export function parseIntelDownload(
  raw: string,
  fetchedAt: string,
  sourceUrl: string,
): SourceBatch {
  const lines = htmlLines(raw);
  const joined = lines.join("\n");
  const versionMatch = joined.match(/(?:Graphics Driver|Version:)\s*(\d+\.\d+\.\d+\.\d+)/i);
  const dateMatch = joined.match(/(?:Release Date|Date:)\s*([^\n]+)/i);
  const dateHeadingIndex = lines.findIndex((line) => /^(?:Release )?Date$/i.test(line));
  const releaseDate = dateMatch?.[1] ?? (dateHeadingIndex >= 0 ? lines[dateHeadingIndex + 1] : undefined);
  if (!versionMatch?.[1] || !releaseDate) throw new Error("Intel download shape changed");
  const latestVersion = validVersion(versionMatch[1], "intel", "windows", "gpu");
  const releasedAt = isoDate(releaseDate);
  const games = sectionItems(lines, /Game On Driver support.*for:?$/i, [
    /^OS Support:?$/i,
    /^Fixed Issues:?$/i,
    /^Game performance improvements/i,
    /^Known Issues/i,
  ]);
  const requirementBatch = boundedRequirements(
    "intel",
    latestVersion,
    releasedAt,
    sourceUrl,
    fetchedAt,
    games,
  );
  return {
    catalog: [
      {
        vendor: "intel",
        os: "windows",
        component: "gpu",
        latestVersion,
        releasedAt,
        sourceUrl,
        fetchedAt,
      },
    ],
    ...requirementBatch,
  };
}

export function parseMesaIndex(raw: string): { version: string; detailsUrl: string } {
  const versions = [...raw.matchAll(/href=["'](?:\.\/)?relnotes\/(\d+\.\d+\.\d+)\.html["']/gi)]
    .map((match) => match[1]!)
    .filter((version) => VERSION.test(version));
  if (versions.length === 0) throw new Error("Mesa index had no stable release links");
  versions.sort((a, b) => compareDriverVersions(b, a));
  const version = versions[0]!;
  return { version, detailsUrl: `https://docs.mesa3d.org/relnotes/${version}.html` };
}

export function parseMesaDetails(
  raw: string,
  expectedVersion: string,
  fetchedAt: string,
  sourceUrl: string,
): SourceBatch {
  const lines = htmlLines(raw);
  const heading = lines.find((line) => line.includes(`Mesa ${expectedVersion} Release Notes`));
  const date = heading?.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!date || !ISO_DATE.test(date)) throw new Error("Mesa details shape changed");
  const version = validVersion(expectedVersion, "amd", "linux", "mesa");
  return {
    catalog: (["amd", "intel"] as const).map((vendor) => ({
      vendor,
      os: "linux",
      component: "mesa",
      latestVersion: version,
      releasedAt: date,
      sourceUrl,
      fetchedAt,
    })),
    requirements: [],
    dropped: 0,
  };
}

export function parseFallbackCsv(raw: string): SourceBatch {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  const expectedHeader =
    "kind,vendor,os,component,version,released_at,checked_at,source_url,title";
  if (lines.shift()?.toLowerCase() !== expectedHeader) throw new Error("fallback CSV header changed");
  const catalog: DriverCatalogRecord[] = [];
  const requirements: GameRequirementCandidate[] = [];
  for (const line of lines) {
    const [kind, vendor, os, component, version, releasedAt, checkedAt, sourceUrl, gameTitle] =
      splitCsvLine(line, ",").map((cell) => cell.trim());
    if (
      !kind ||
      !vendor ||
      !(["amd", "intel"] as string[]).includes(vendor) ||
      os !== "windows" ||
      component !== "gpu" ||
      !version ||
      !releasedAt ||
      !checkedAt ||
      !sourceUrl
    ) {
      throw new Error("invalid fallback CSV row");
    }
    const checkedIso = `${isoDate(checkedAt)}T00:00:00.000Z`;
    const normalizedVersion = validVersion(version, vendor as "amd" | "intel", "windows", "gpu");
    const source = new URL(sourceUrl);
    const validatedSource =
      vendor === "amd"
        ? amdReleaseNotesUrl(source.href, normalizedVersion)
        : source.protocol === "https:" && source.hostname === "www.intel.com"
          ? source.href
          : null;
    if (!validatedSource) throw new Error("fallback source URL left the vendor host");
    const base = {
      vendor: vendor as "amd" | "intel",
      os: "windows" as const,
      latestVersion: normalizedVersion,
      releasedAt: isoDate(releasedAt),
      sourceUrl: validatedSource,
      fetchedAt: checkedIso,
    };
    if (kind === "catalog") {
      catalog.push({ ...base, component: "gpu" });
    } else if (kind === "requirement" && gameTitle) {
      const normalizedTitle = title(gameTitle);
      if (!normalizedTitle) throw new Error("invalid fallback game title");
      requirements.push({
        vendor: base.vendor,
        os: "windows",
        minVersion: normalizedVersion,
        title: normalizedTitle,
        releasedAt: base.releasedAt,
        sourceUrl: base.sourceUrl,
        fetchedAt: base.fetchedAt,
      });
    } else {
      throw new Error("invalid fallback CSV kind/title");
    }
  }
  return { catalog, requirements, dropped: 0 };
}

export interface SourceDeps {
  fetchImpl?: typeof fetch;
  now: Date;
}

export type SourceLoader = (deps: SourceDeps) => Promise<SourceBatch>;

export interface DriverSource {
  name: string;
  load: SourceLoader;
}

export async function loadAmdChangelog({ fetchImpl, now }: SourceDeps): Promise<SourceBatch> {
  const fetchedAt = now.toISOString();
  const raw = await fetchText(SOURCE_URLS.amdChangelog, {
    allowedHosts: ["changelog.gg"],
    fetchImpl,
    maxBytes: 512 * 1024,
  });
  const discovery = parseAmdChangelog(raw, fetchedAt);
  const details = await fetchText(discovery.verificationUrl, {
    allowedHosts: ["www.amd.com"],
    fetchImpl,
  });
  const batch = parseAmdDriverPage(details, fetchedAt);
  const catalog = batch.catalog[0];
  if (
    !catalog ||
    catalog.latestVersion !== discovery.version ||
    catalog.releasedAt !== discovery.releasedAt ||
    catalog.sourceUrl !== discovery.detailsUrl
  ) {
    throw new Error("Changelog.gg AMD metadata did not match the official driver page");
  }
  return batch;
}

/**
 * Every source that can independently establish a catalog row.
 *
 * The two AMD Windows entries look duplicative — both end up parsing a
 * www.amd.com page for the same record, which `mergeBatches` then collapses via
 * `preferNewer` — but the overlap is the point, not an oversight. `curateDrivers`
 * merges only the sources that succeed, so the pair are independent discovery
 * paths: `amd-windows-changelog-discovery` cross-checks changelog.gg against the
 * official page, while `amd-windows` walks AMD's own index. Either can survive a
 * layout change that breaks the other, and a catalog that goes stale past
 * `driverCatalogMaxAgeDays` silently suppresses every driver advisory. Two
 * fetches a run is a cheap price for that; do not "deduplicate" them.
 */
export const LIVE_DRIVER_SOURCES = [
  {
    name: "nvidia-windows",
    load: async ({ fetchImpl, now }) => {
      const fetchedAt = now.toISOString();
      const raw = await fetchText(SOURCE_URLS.nvidiaWindows, {
        allowedHosts: ["gfwsl.geforce.com"],
        fetchImpl,
      });
      return parseNvidiaLookup(raw, "windows", fetchedAt);
    },
  },
  {
    name: "nvidia-linux",
    load: async ({ fetchImpl, now }) => {
      const fetchedAt = now.toISOString();
      const latest = await fetchText(SOURCE_URLS.nvidiaLinuxLatest, {
        allowedHosts: ["download.nvidia.com"],
        fetchImpl,
      });
      const { detailsUrl } = parseNvidiaLinuxPointer(latest);
      const details = await fetchText(detailsUrl, {
        allowedHosts: ["download.nvidia.com"],
        fetchImpl,
      });
      return parseNvidiaLinuxLatest(latest, details, fetchedAt);
    },
  },
  {
    name: "amd-windows-changelog-discovery",
    load: loadAmdChangelog,
  },
  {
    name: "amd-windows",
    load: async ({ fetchImpl, now }) => {
      const fetchedAt = now.toISOString();
      const index = await fetchText(SOURCE_URLS.amdIndex, {
        allowedHosts: ["www.amd.com"],
        fetchImpl,
      });
      const detailsUrl = parseAmdIndex(index);
      const details = await fetchText(detailsUrl, {
        allowedHosts: ["www.amd.com"],
        fetchImpl,
      });
      return parseAmdReleaseNotes(details, fetchedAt, detailsUrl);
    },
  },
  {
    name: "intel-windows",
    load: async ({ fetchImpl, now }) => {
      const fetchedAt = now.toISOString();
      const raw = await fetchText(SOURCE_URLS.intelWindows, {
        allowedHosts: ["www.intel.com"],
        fetchImpl,
      });
      return parseIntelDownload(raw, fetchedAt, SOURCE_URLS.intelWindows);
    },
  },
  {
    name: "mesa-linux",
    load: async ({ fetchImpl, now }) => {
      const fetchedAt = now.toISOString();
      const index = await fetchText(SOURCE_URLS.mesaIndex, {
        allowedHosts: ["docs.mesa3d.org"],
        fetchImpl,
      });
      const latest = parseMesaIndex(index);
      const details = await fetchText(latest.detailsUrl, {
        allowedHosts: ["docs.mesa3d.org"],
        fetchImpl,
      });
      return parseMesaDetails(details, latest.version, fetchedAt, latest.detailsUrl);
    },
  },
] as const satisfies readonly DriverSource[];
