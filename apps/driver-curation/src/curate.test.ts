import { describe, expect, it, vi } from "vitest";

import { curateDrivers, mergeBatches } from "./curate";
import type { DriverSource, SourceLoader } from "./sources";
import type {
  CurationBatch,
  DriverCatalogRecord,
  PersistReport,
  SourceBatch,
} from "./types";

const now = new Date("2026-07-13T12:00:00.000Z");
const row = (
  vendor: DriverCatalogRecord["vendor"],
  os: DriverCatalogRecord["os"],
  component: DriverCatalogRecord["component"],
): DriverCatalogRecord => ({
  vendor,
  os,
  component,
  latestVersion: component === "mesa" ? "26.1.4" : "610.74",
  releasedAt: "2026-07-01",
  sourceUrl: "https://example.com/source",
  fetchedAt: now.toISOString(),
});

const batch = (catalog: DriverCatalogRecord[]): SourceBatch => ({
  catalog,
  requirements: [],
  dropped: 0,
});

describe("curateDrivers", () => {
  it("keeps the higher version when sources disagree on the same release date", () => {
    const higher: SourceBatch = {
      catalog: [{ ...row("nvidia", "windows", "gpu"), latestVersion: "610.75" }],
      requirements: [
        {
          vendor: "nvidia",
          os: "windows",
          minVersion: "610.75",
          title: "Example Game",
          releasedAt: "2026-07-01",
          sourceUrl: "https://example.com/higher",
          fetchedAt: now.toISOString(),
        },
      ],
      dropped: 0,
    };
    const lower: SourceBatch = {
      catalog: [{ ...row("nvidia", "windows", "gpu"), latestVersion: "610.74" }],
      requirements: [
        {
          ...higher.requirements[0]!,
          minVersion: "610.74",
          title: "Example Game™",
          sourceUrl: "https://example.com/lower",
        },
      ],
      dropped: 0,
    };

    const merged = mergeBatches([higher, lower]);

    expect(merged.catalog[0]?.latestVersion).toBe("610.75");
    expect(merged.requirements).toHaveLength(1);
    expect(merged.requirements[0]?.minVersion).toBe("610.75");
  });

  it("isolates source failures and keeps all six currency cells through fallback", async () => {
    const named = (name: string, load: SourceLoader): DriverSource => ({ name, load });
    const sources: DriverSource[] = [
      named("nvidia-windows", async () => batch([row("nvidia", "windows", "gpu")])),
      named("nvidia-linux", async () => batch([row("nvidia", "linux", "gpu")])),
      named("amd-windows", async () => {
        throw new Error("AMD changed markup");
      }),
      named("intel-windows", async () => {
        throw new Error("Intel rate limited");
      }),
      named("mesa-linux", async () =>
        batch([row("amd", "linux", "mesa"), row("intel", "linux", "mesa")]),
      ),
    ];
    const persist = vi.fn(async (value: CurationBatch): Promise<PersistReport> => ({
      catalogUpserted: value.catalog.length,
      requirementsUpserted: 0,
      requirementsReceived: value.requirements.length,
      requirementsMatched: 0,
      unmatchedTitles: value.requirements.map((item) => item.title),
    }));
    const actual = await curateDrivers({
      now,
      sources,
      persist,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const persisted = persist.mock.calls[0]![0];
    expect(persisted.catalog.map((item) => `${item.os}:${item.vendor}:${item.component}`).sort()).toEqual([
      "linux:amd:mesa",
      "linux:intel:mesa",
      "linux:nvidia:gpu",
      "windows:amd:gpu",
      "windows:intel:gpu",
      "windows:nvidia:gpu",
    ]);
    expect(actual.sourcesFailed).toEqual(["amd-windows", "intel-windows"]);
  });
});
