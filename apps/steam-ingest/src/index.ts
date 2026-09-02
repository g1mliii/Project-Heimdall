import { executorFor } from "./db";
import { runLane } from "./ingest";
import type { IngestLane } from "./types";

interface Env {
  DATABASE_URL: string;
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
      const report = await runLane(lane, { execute: executorFor(env.DATABASE_URL) });
      console.info("steam ingest complete", {
        lane: report.lane,
        appsPolled: report.appsPolled,
        rowsWritten: report.rowsWritten,
        appsFailed: report.appsFailed,
        changesRecorded: report.changesRecorded,
      });
    } catch {
      // Same posture as driver-curation: never let a connection string or a
      // store payload escape into persisted logs through a thrown cause chain.
      console.error("steam ingest failed", { lane });
      throw new Error(`steam ingest failed: ${lane}`);
    }
  },
} satisfies ExportedHandler<Env>;
