import { describe, expect, it } from "vitest";

import { cleanDisplayName, normalizeAliasName, slugifyGameName } from "./naming";

describe("normalizeAliasName (§4.4 alias keys)", () => {
  it("lowercases, trims, collapses whitespace, and strips marks", () => {
    expect(normalizeAliasName("  Cyberpunk   2077 ")).toBe("cyberpunk 2077");
    expect(normalizeAliasName("NVIDIA GeForce RTX™ 4070")).toBe("nvidia geforce rtx 4070");
    expect(normalizeAliasName("AMD Ryzen™ 7 7800X3D®")).toBe("amd ryzen 7 7800x3d");
  });

  it("is idempotent", () => {
    const once = normalizeAliasName("  Counter-Strike   2™ ");
    expect(normalizeAliasName(once)).toBe(once);
  });

  it("keeps diacritics (alias keys match what users submit)", () => {
    expect(normalizeAliasName("Pokémon — Légendes")).toBe("pokémon — légendes");
  });

  it("cleanDisplayName keeps casing and lowercases to exactly the alias key", () => {
    for (const raw of ["NVIDIA GeForce RTX™ 4070", "  Cyberpunk   2077 ", "AMD Ryzen™ 7"]) {
      expect(cleanDisplayName(raw).toLowerCase()).toBe(normalizeAliasName(raw));
    }
    expect(cleanDisplayName("NVIDIA GeForce RTX™ 4070")).toBe("NVIDIA GeForce RTX 4070");
  });
});

describe("slugifyGameName", () => {
  it("produces url-safe hyphenated slugs", () => {
    expect(slugifyGameName("Cyberpunk 2077")).toBe("cyberpunk-2077");
    expect(slugifyGameName("Counter-Strike 2")).toBe("counter-strike-2");
    expect(slugifyGameName("S.T.A.L.K.E.R. 2: Heart of Chornobyl")).toBe(
      "s-t-a-l-k-e-r-2-heart-of-chornobyl",
    );
  });

  it("folds diacritics but keeps unicode letters", () => {
    expect(slugifyGameName("Pokémon — Légendes")).toBe("pokemon-legendes");
    // CJK titles survive rather than collapsing to nothing.
    expect(slugifyGameName("原神")).toBe("原神");
  });

  it("never returns an empty slug", () => {
    expect(slugifyGameName("™®©")).toBe("untitled");
    expect(slugifyGameName("   ")).toBe("untitled");
  });

  it("is idempotent", () => {
    const once = slugifyGameName("Baldur's Gate 3™");
    expect(slugifyGameName(once)).toBe(once);
  });
});
