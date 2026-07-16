import type { DiagnosticsDriverCatalog, DiagnosticsDriverPlatform } from "@heimdall/parsers";

export type DriverVendor = DiagnosticsDriverPlatform["vendor"];

export interface DriverCatalogRecord extends DiagnosticsDriverCatalog {
  gpuSeries?: string;
  releasedAt: string;
  sourceUrl: string;
  fetchedAt: string;
}

export interface GameRequirementCandidate {
  vendor: DriverVendor;
  os: "windows";
  minVersion: string;
  title: string;
  releasedAt: string;
  sourceUrl: string;
  fetchedAt: string;
}

export interface SourceBatch {
  catalog: DriverCatalogRecord[];
  requirements: GameRequirementCandidate[];
  dropped: number;
}

export interface CurationBatch {
  catalog: DriverCatalogRecord[];
  requirements: GameRequirementCandidate[];
}

export interface PersistReport {
  catalogUpserted: number;
  requirementsUpserted: number;
  requirementsReceived: number;
  requirementsMatched: number;
  unmatchedTitles: string[];
}

export interface CurationReport extends PersistReport {
  sourcesSucceeded: string[];
  sourcesFailed: string[];
  droppedBySources: number;
}

export interface CurationLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
