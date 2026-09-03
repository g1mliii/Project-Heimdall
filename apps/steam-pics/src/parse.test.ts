import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { decimalString, epochToIso, parseProductInfo } from "./parse.js";

const fixture = JSON.parse(
  await readFile(path.resolve(import.meta.dirname, "../fixtures/product-info.json"), "utf8"),
) as Record<string, { changenumber: number; appinfo: unknown }>;

const parse = (appid: string) =>
  parseProductInfo(Number(appid), fixture[appid]!.changenumber, fixture[appid]!.appinfo);

describe("builds", () => {
  it("reads every branch of the confirmed CS2 payload", () => {
    const parsed = parse("730");
    expect(parsed.name).toBe("Counter-Strike 2");
    // Steam answers "Game" here and "game" for appid 570; both normalise.
    expect(parsed.appType).toBe("game");

    const publicBranch = parsed.builds.find((build) => build.branch === "public");
    expect(publicBranch).toEqual({
      appid: 730,
      branch: "public",
      buildid: "25000182",
      timeUpdated: new Date(1787950286 * 1000).toISOString(),
      timeBuildUpdated: new Date(1787948178 * 1000).toISOString(),
      description: null,
      changenumber: 38552948,
    });
    expect(parsed.builds.length).toBeGreaterThan(10);
  });

  it("keeps a non-public branch's own label", () => {
    const legacy = parse("730").builds.find((build) => build.branch === "csgo_legacy");
    expect(legacy).toMatchObject({
      buildid: "12426195",
      description: "Legacy Version of CS:GO",
    });
  });

  it("normalises the lowercase `game` type the other app reports", () => {
    const parsed = parse("570");
    expect(parsed.name).toBe("Dota 2");
    expect(parsed.appType).toBe("game");
    expect(parsed.builds).toEqual([
      expect.objectContaining({ branch: "public", buildid: "25089218" }),
    ]);
  });

  it("returns no builds for an app that has no depots block at all", () => {
    // A soundtrack. Absence here is normal, not a parse failure.
    const parsed = parse("2678630");
    expect(parsed.name).toBe("Counter-Strike 2 Soundtrack");
    expect(parsed.builds).toEqual([]);
    expect(parsed.depots).toEqual([]);
    expect(parsed.manifests).toEqual([]);
  });

  it("skips a branch with no buildid rather than inventing one", () => {
    const parsed = parseProductInfo(1, null, {
      depots: { branches: { public: { buildid: "5" }, beta: { pwdrequired: "1" } } },
    });
    expect(parsed.builds.map((build) => build.branch)).toEqual(["public"]);
  });
});

describe("depots and manifests", () => {
  it("treats only numeric keys as depots, never the config keys beside them", () => {
    const parsed = parse("730");
    // `branches`, `privatebranches`, `workshopdepot`, `baselanguages` etc. all
    // live in the same object and must not become depots.
    expect(parsed.depots.length).toBeGreaterThan(10);
    for (const depot of parsed.depots) expect(depot.depotId).toMatch(/^[0-9]+$/);
    expect(parsed.depots.some((depot) => depot.depotId === "731")).toBe(true);
  });

  it("carries a system-defined depot with a null name rather than dropping it", () => {
    const depot = parse("730").depots.find((entry) => entry.depotId === "731");
    expect(depot).toMatchObject({ appid: 730, depotId: "731", name: null });
  });

  it("PRESERVES 19-digit manifest gids exactly, which a JS number cannot", () => {
    const manifest = parse("730").manifests.find(
      (entry) => entry.depotId === "731" && entry.branch === "public",
    );
    expect(manifest!.manifestGid).toBe("6967806384656644903");
    // The precision trap this guards: the gid is larger than 2^53, so any path
    // through Number() silently rewrites it.
    expect(Number(manifest!.manifestGid).toString()).not.toBe(manifest!.manifestGid);
    expect(typeof manifest!.manifestGid).toBe("string");
  });

  it("keeps sizes as strings so Postgres does the widening", () => {
    const manifest = parse("730").manifests.find(
      (entry) => entry.depotId === "731" && entry.branch === "csgo_legacy",
    );
    expect(manifest).toMatchObject({ sizeBytes: "32722411363", downloadBytes: "13644292112" });
  });

  it("accepts the older bare-gid manifest form", () => {
    const parsed = parseProductInfo(1, null, {
      depots: { "5": { manifests: { public: "12345678901234567890" } } },
    });
    expect(parsed.manifests).toEqual([
      {
        appid: 1,
        depotId: "5",
        branch: "public",
        manifestGid: "12345678901234567890",
        sizeBytes: null,
        downloadBytes: null,
      },
    ]);
  });
});

describe("decimalString", () => {
  it("keeps large decimal strings byte-for-byte", () => {
    expect(decimalString("6967806384656644903")).toBe("6967806384656644903");
  });

  it("strips leading zeros without mangling a zero", () => {
    expect(decimalString("007")).toBe("7");
    expect(decimalString("0")).toBe("0");
  });

  it("rejects anything that is not a plain non-negative integer", () => {
    for (const value of ["-1", "1.5", "1e3", "abc", "", null, undefined, {}, 1.5, -1]) {
      expect(decimalString(value)).toBeNull();
    }
  });

  it("accepts a JSON number only while it is exactly representable", () => {
    expect(decimalString(25000182)).toBe("25000182");
    expect(decimalString(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });
});

describe("epochToIso", () => {
  it("converts Steam's unix-seconds strings", () => {
    expect(epochToIso("1787950286")).toBe(new Date(1787950286 * 1000).toISOString());
  });

  it("rejects implausible timestamps instead of storing a 1970 date", () => {
    for (const value of ["0", "1", "99999999999", "", "abc", null]) {
      expect(epochToIso(value)).toBeNull();
    }
  });
});

describe("malformed input", () => {
  it("never throws on a shape Steam has not sent before", () => {
    for (const appinfo of [null, undefined, 42, "text", [], { depots: "nope" }, { depots: {} }]) {
      expect(() => parseProductInfo(1, null, appinfo)).not.toThrow();
    }
  });
});
