import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseAmdIndex,
  parseAmdReleaseNotes,
  parseFallbackCsv,
  parseIntelDownload,
  parseMesaDetails,
  parseMesaIndex,
  parseNvidiaLinuxLatest,
  parseNvidiaLookup,
} from "./sources";

const fetchedAt = "2026-07-13T12:00:00.000Z";
const fixture = (name: string) =>
  readFile(path.resolve(import.meta.dirname, "../fixtures", name), "utf8");

describe("driver source contracts", () => {
  it("parses the confirmed NVIDIA Windows lookup and game-ready titles", async () => {
    const batch = parseNvidiaLookup(
      await fixture("nvidia-windows.json"),
      "windows",
      fetchedAt,
    );
    expect(batch.catalog).toEqual([
      expect.objectContaining({
        vendor: "nvidia",
        os: "windows",
        component: "gpu",
        latestVersion: "610.74",
        releasedAt: "2026-07-07",
      }),
    ]);
    expect(batch.requirements.map((row) => row.title)).toEqual([
      "DOOM: The Dark Ages | Revelations",
      "Assassin's Creed Black Flag Resynced",
    ]);
  });

  it("parses NVIDIA's confirmed Linux latest.txt + directory-index contract", async () => {
    const batch = parseNvidiaLinuxLatest(
      await fixture("nvidia-linux-latest.txt"),
      await fixture("nvidia-linux-details.html"),
      fetchedAt,
    );
    expect(batch.catalog[0]).toMatchObject({
      vendor: "nvidia",
      os: "linux",
      latestVersion: "595.84",
      releasedAt: "2026-06-11",
    });
    expect(batch.requirements).toEqual([]);
  });

  it("parses AMD's index and release-note game-support section", async () => {
    const url = parseAmdIndex(await fixture("amd-index.html"));
    const batch = parseAmdReleaseNotes(await fixture("amd-release.html"), fetchedAt, url);
    expect(batch.catalog[0]).toMatchObject({ vendor: "amd", latestVersion: "26.6.1" });
    expect(batch.requirements.map((row) => row.title)).toEqual([
      "F1 25: 2026 Season Pack",
      "World of Tanks: HEAT",
    ]);
  });

  it("parses AMD's confirmed 26.6.4 hotfix without inventing game requirements", async () => {
    const sourceUrl =
      "https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-6-4.html";
    const batch = parseAmdReleaseNotes(
      await fixture("amd-hotfix-release.html"),
      fetchedAt,
      sourceUrl,
    );
    expect(batch.catalog[0]).toMatchObject({
      vendor: "amd",
      latestVersion: "26.6.4",
      releasedAt: "2026-06-29",
      sourceUrl,
    });
    expect(batch.requirements).toEqual([]);
  });

  it("accepts AMD's vendor-relative release-note links", () => {
    expect(
      parseAmdIndex(
        `<a href="/en/resources/support-articles/release-notes/RN-RAD-WIN-26-6-1.html">Current</a>`,
      ),
    ).toBe(
      "https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-26-6-1.html",
    );
  });

  it("parses Intel's full build and Game On list", async () => {
    const batch = parseIntelDownload(
      await fixture("intel-download.html"),
      fetchedAt,
      "https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html",
    );
    expect(batch.catalog[0]).toMatchObject({ vendor: "intel", latestVersion: "32.0.101.8861" });
    expect(batch.requirements.map((row) => row.title)).toEqual([
      "Assassin's Creed Black Flag Resynced",
      "DOOM: The Dark Ages | Revelations",
    ]);
  });

  it("accepts Intel's production layout where Date and Version values are separate lines", () => {
    const batch = parseIntelDownload(
      `<h1>Intel® Arc™ Graphics - Windows*</h1>
       <div>Date</div><div>7/7/2026</div>
       <div>Version</div><div>32.0.101.8861 (Latest)</div>
       <p>This download installs Intel® Graphics Driver 32.0.101.8861.</p>
       <h2>Highlights</h2>
       <p>Intel® Game On Driver support on Intel® Arc™ GPUs for:</p>
       <ul><li>Echoes of Aincrad*</li></ul><h2>OS Support:</h2>`,
      fetchedAt,
      "https://www.intel.com/content/www/us/en/download/785597/intel-arc-graphics-windows.html",
    );
    expect(batch.catalog[0]).toMatchObject({
      latestVersion: "32.0.101.8861",
      releasedAt: "2026-07-07",
    });
    expect(batch.requirements[0]?.title).toBe("Echoes of Aincrad");
  });

  it("selects the newest stable Mesa release and maps it to AMD + Intel", async () => {
    const latest = parseMesaIndex(await fixture("mesa-index.html"));
    expect(latest).toEqual({
      version: "26.1.4",
      detailsUrl: "https://docs.mesa3d.org/relnotes/26.1.4.html",
    });
    const batch = parseMesaDetails(
      await fixture("mesa-details.html"),
      latest.version,
      fetchedAt,
      latest.detailsUrl,
    );
    expect(batch.catalog).toEqual([
      expect.objectContaining({ vendor: "amd", os: "linux", component: "mesa" }),
      expect.objectContaining({ vendor: "intel", os: "linux", component: "mesa" }),
    ]);
  });

  it("preserves fallback checked-at freshness instead of stamping now", () => {
    const batch = parseFallbackCsv(
      "kind,vendor,os,component,version,released_at,checked_at,source_url,title\n" +
        "catalog,amd,windows,gpu,26.6.1,2026-06-02,2026-07-01,https://www.amd.com/release,\n",
    );
    expect(batch.catalog[0]?.fetchedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("keeps AMD's latest currency separate from older game-ready requirements", async () => {
    const batch = parseFallbackCsv(
      await readFile(path.resolve(import.meta.dirname, "../data/driver-fallback.csv"), "utf8"),
    );
    expect(batch.catalog.find((row) => row.vendor === "amd")).toMatchObject({
      latestVersion: "26.6.4",
      releasedAt: "2026-06-29",
    });
    expect(
      batch.requirements.filter((row) => row.vendor === "amd").map((row) => row.minVersion),
    ).toEqual(["26.6.1", "26.6.1"]);
  });
});
