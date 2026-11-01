import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CRON_LANES } from "./index";
import { LANE_CADENCE_MS } from "./sources";

/**
 * Distinct minutes per day in which some lane touches Neon. Every invocation
 * wakes the compute, which then idles 5 min before suspending, so wakes — not
 * rows — are what spend the monthly compute quota. A `*\/10` players lane was
 * 144 wakes/day on its own and exhausted the free plan's quota on 2026-10-29,
 * taking every lane and the PICS collector down until the monthly reset.
 *
 * 60/day × ~5.5 min awake × 0.25 CU ≈ 1.4 CU-hours/day, ~43/month: leaves
 * room for the PICS job and web traffic under a 100 CU-hour plan.
 */
const MAX_DB_WAKE_MINUTES_PER_DAY = 60;

const MINUTE_MS = 60 * 1000;
const DAY_MINUTES = 24 * 60;

function wranglerCrons(): string[] {
  const path = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  // Comments in this file sit on their own lines; strip those before parsing.
  const json = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return (JSON.parse(json) as { triggers: { crons: string[] } }).triggers.crons;
}

/** Expands one cron field (`*`, `*\/n`, `a,b`, `n`) — all wrangler.jsonc uses. */
function field(spec: string, size: number): number[] {
  if (spec === "*") return Array.from({ length: size }, (_, i) => i);
  const step = /^\*\/(\d+)$/.exec(spec);
  if (step) return Array.from({ length: size }, (_, i) => i).filter((i) => i % Number(step[1]) === 0);
  return spec.split(",").map((part) => {
    if (!/^\d+$/.test(part)) throw new Error(`unsupported cron field: ${spec}`);
    return Number(part);
  });
}

/** Minutes-of-day a daily-periodic cron fires at (day/month/weekday must be `*`). */
function fireMinutes(cron: string): number[] {
  const [minute, hour, ...rest] = cron.split(" ");
  if (rest.some((f) => f !== "*")) throw new Error(`not daily-periodic: ${cron}`);
  return field(hour!, 24)
    .flatMap((h) => field(minute!, 60).map((m) => h * 60 + m))
    .sort((a, b) => a - b);
}

describe("cron triggers", () => {
  it("wrangler.jsonc and CRON_LANES name exactly the same expressions", () => {
    expect([...wranglerCrons()].sort()).toEqual(Object.keys(CRON_LANES).sort());
  });

  it("each lane fires on its own LANE_CADENCE_MS grid, so buckets and rotation stay aligned", () => {
    for (const [cron, lane] of Object.entries(CRON_LANES)) {
      const minutes = fireMinutes(cron);
      const gaps = minutes.map((m, i) => ((minutes[(i + 1) % minutes.length]! - m + DAY_MINUTES) % DAY_MINUTES) || DAY_MINUTES);
      // Every gap equal to the cadence: one invocation per bucket, no bucket skipped.
      expect(new Set(gaps), `${lane} (${cron})`).toEqual(new Set([LANE_CADENCE_MS[lane] / MINUTE_MS]));
    }
  });

  it(`wakes the database in at most ${MAX_DB_WAKE_MINUTES_PER_DAY} distinct minutes a day`, () => {
    const wakes = new Set(Object.keys(CRON_LANES).flatMap(fireMinutes));
    expect(wakes.size).toBeLessThanOrEqual(MAX_DB_WAKE_MINUTES_PER_DAY);
  });
});
