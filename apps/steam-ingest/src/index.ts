import { executorFor } from "./db";
import { runLane } from "./ingest";
import type { IngestLane } from "./types";

interface Env {
  DATABASE_URL: string;
  /**
   * Publisher key for IStoreService/GetAppList (8.7.8). OPTIONAL: absent means
   * the bulk catalog seed is skipped and discovery still runs from charts and
   * featured. Set it with `wrangler secret put STEAM_API_KEY` — a repository
   * secret or a local .env does not reach a deployed Worker.
   */
  STEAM_API_KEY?: string;
}

/**
 * Cron expression → lane. These strings must match wrangler.jsonc exactly;
 * a cron with no entry here fires and does nothing, which is why the handler
 * logs the unmapped expression instead of failing silently.
 */
export const CRON_LANES: Record<string, IngestLane> = {
  "*/10 * * * *": "players",
  "7 * * * *": "reviews",
  "23 3,9,15,21 * * *": "prices",
  "41 4 * * *": "catalog",
};

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const lane = CRON_LANES[controller.cron];
    if (!lane) {
      console.error("steam ingest: unmapped cron", { cron: controller.cron });
      return;
    }
    try {
      const report = await runLane(lane, {
        execute: executorFor(env.DATABASE_URL),
        steamApiKey: env.STEAM_API_KEY,
      });
      console.info("steam ingest complete", {
        lane: report.lane,
        appsPolled: report.appsPolled,
        rowsWritten: report.rowsWritten,
        appsFailed: report.appsFailed,
        changesRecorded: report.changesRecorded,
        appsSeeded: report.appsSeeded,
        gamesLinked: report.gamesLinked,
      });
    } catch {
      // Same posture as driver-curation: never let a connection string or a
      // store payload escape into persisted logs through a thrown cause chain.
      console.error("steam ingest failed", { lane });
      throw new Error(`steam ingest failed: ${lane}`);
    }
  },
} satisfies ExportedHandler<Env>;
