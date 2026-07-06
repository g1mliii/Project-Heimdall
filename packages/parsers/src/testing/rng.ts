/**
 * Deterministic seeded RNG for the property-style suites: a numerical-recipes
 * LCG, so failures reproduce exactly from the seed. Returns values in [0, 1].
 */
export function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}
