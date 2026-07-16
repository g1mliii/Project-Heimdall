import type {
  DiagnosticsDriverCatalog,
  DiagnosticsDriverPlatform,
  DiagnosticsInput,
} from "@heimdall/parsers";
import type { CaptureSource, HardwareSnapshot } from "@heimdall/shared";

interface DiagnosticMetadataInput {
  hardware: HardwareSnapshot;
  captureSource: CaptureSource;
  requiredDriver: string | null;
  requiredDriverProvenance: { sourceUrl?: string; fetchedAt?: string } | null;
  driverPlatform: DiagnosticsDriverPlatform | null;
  driverCatalog: DiagnosticsDriverCatalog | null;
}

type DiagnosticMetadata = Pick<
  DiagnosticsInput,
  "hardware" | "source" | "vendor" | "game" | "driverPlatform" | "driverCatalog"
>;

/** Shared server-owned metadata for live and historical diagnostic evaluation. */
export function buildDiagnosticMetadata({
  hardware,
  captureSource,
  requiredDriver,
  requiredDriverProvenance,
  driverPlatform,
  driverCatalog,
}: DiagnosticMetadataInput): DiagnosticMetadata {
  return {
    hardware,
    source: captureSource,
    vendor: hardware.gpuVendor ?? "unknown",
    ...(requiredDriver === null
      ? {}
      : {
          game: {
            requiredDriver,
            ...(requiredDriverProvenance?.sourceUrl === undefined
              ? {}
              : { requiredDriverSourceUrl: requiredDriverProvenance.sourceUrl }),
            ...(requiredDriverProvenance?.fetchedAt === undefined
              ? {}
              : { requiredDriverFetchedAt: requiredDriverProvenance.fetchedAt }),
          },
        }),
    ...(driverPlatform === null ? {} : { driverPlatform }),
    ...(driverCatalog === null ? {} : { driverCatalog }),
  };
}
