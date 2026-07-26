import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GRAPHICS_API_ALIASES, canonicalGraphicsApi } from "./graphics-api";

describe("canonicalGraphicsApi", () => {
  it("collapses known spelling aliases", () => {
    expect(canonicalGraphicsApi("DirectX 12")).toBe("dx12");
    expect(canonicalGraphicsApi("D3D-11")).toBe("dx11");
    expect(canonicalGraphicsApi("  Vulkan  ")).toBe("vulkan");
  });

  it("preserves trimmed unknown free text rather than dropping it", () => {
    // Unknown APIs must stay distinct — collapsing them would pool genuinely
    // different rendering pipelines into one cohort.
    expect(canonicalGraphicsApi("  Proton D9VK ")).toBe("Proton D9VK");
  });
});

describe("migration 0039 alias parity", () => {
  /**
   * The backfill migration hand-copies GRAPHICS_API_ALIASES into SQL, and a
   * merged migration is frozen. Without this guard an alias added here would
   * canonicalize new writes while stored rows kept the old spelling, splitting
   * one cohort in two with nothing failing.
   */
  it("lists exactly the aliases the shared table knows", () => {
    const sql = readFileSync(
      fileURLToPath(new URL("../../../infra/db/migrations/0039_canonical_graphics_api.sql", import.meta.url)),
      "utf8",
    );
    const filter = sql.slice(sql.indexOf("where alias in ("));
    const listed = [...filter.slice(0, filter.indexOf(")")).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual(Object.keys(GRAPHICS_API_ALIASES).sort());
  });
});
