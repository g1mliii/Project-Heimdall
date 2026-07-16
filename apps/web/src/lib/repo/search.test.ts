import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAX_INDEXED_METADATA_TEXT_LENGTH,
  SEARCH_SIMILARITY_THRESHOLD,
} from "@heimdall/shared";

import type { Queryable } from "../db";
import { createTestDb, testDbAvailable, type TestDb } from "../testing/test-db";
import { resolveGameId, resolveHardwareId } from "./catalog";
import { SEARCH_CATALOG_SQL, searchCatalog } from "./search";

const canRun = testDbAvailable("search.test");

describe.skipIf(!canRun)("catalog search (§17.6)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();

    const gameId = await resolveGameId("capframex", "Cyberpunk 2077", db.pool);
    const hardwareId = await resolveHardwareId(
      "gpu",
      "capframex",
      "NVIDIA GeForce RTX 4070",
      "nvidia",
      db.pool,
    );
    if (!gameId || !hardwareId) throw new Error("expected canonical search fixtures");

    await db.pool.query(
      `insert into game_aliases (game_id, source, raw_name, normalized_name)
       values ($1, 'user', 'Cyberpunk', 'cyberpunk')`,
      [gameId],
    );
    await db.pool.query(
      `insert into hardware_aliases (hardware_id, kind, source, raw_name, normalized_name)
       values ($1, 'gpu', 'user', '4070', '4070')`,
      [hardwareId],
    );
  }, 240_000);

  afterAll(async () => {
    await db?.teardown();
  });

  it("finds a canonical game from a typo and deduplicates its name + alias hits", async () => {
    expect((await searchCatalog("cyberpnk", db.pool)).games).toEqual([
      expect.objectContaining({ slug: "cyberpunk-2077", name: "Cyberpunk 2077" }),
    ]);

    const exact = await searchCatalog("cyberpunk", db.pool);
    expect(exact.games.filter((game) => game.slug === "cyberpunk-2077")).toHaveLength(1);
  });

  it("finds a GPU through its alias while keeping hardware non-navigating data", async () => {
    expect((await searchCatalog("4070", db.pool)).hardware).toEqual([
      expect.objectContaining({
        kind: "gpu",
        vendor: "nvidia",
        canonicalName: "NVIDIA GeForce RTX 4070",
      }),
    ]);
  });

  it("does not touch Postgres for short or overlong queries", async () => {
    let calls = 0;
    const noQueryDb: Queryable = {
      query: (() => {
        calls += 1;
        throw new Error("short searches must not query");
      }) as Queryable["query"],
    };
    await expect(searchCatalog("rt", noQueryDb)).resolves.toEqual({ games: [], hardware: [] });
    await expect(
      searchCatalog("x".repeat(MAX_INDEXED_METADATA_TEXT_LENGTH + 1), noQueryDb),
    ).resolves.toEqual({ games: [], hardware: [] });
    expect(calls).toBe(0);
  });

  it("keeps pg_trgm's session threshold at the explicit search floor", async () => {
    const client = await db.pool.connect();
    try {
      const { rows } = await client.query<{ threshold: string }>(
        "select current_setting('pg_trgm.similarity_threshold') as threshold",
      );
      expect(Number(rows[0]?.threshold)).toBe(SEARCH_SIMILARITY_THRESHOLD);
    } finally {
      client.release();
    }
  });

  it("uses the trigram GIN index for the game-name candidate scan", async () => {
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (format json) ${SEARCH_CATALOG_SQL}`,
        ["cyberpnk", "cyberpnk", SEARCH_SIMILARITY_THRESHOLD, 8, 5, 25],
      );
      const plan = JSON.stringify(rows[0]?.["QUERY PLAN"]);
      expect(plan).toContain("Bitmap Index Scan");
      expect(plan).toContain("games_name_trgm_idx");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});
