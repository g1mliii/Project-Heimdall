import { curateDrivers } from "./curate";

interface Env {
  DATABASE_URL: string;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const report = await curateDrivers({ databaseUrl: env.DATABASE_URL });
      console.info("driver curation complete", {
        catalogUpserted: report.catalogUpserted,
        requirementsUpserted: report.requirementsUpserted,
        requirementsMatched: report.requirementsMatched,
        requirementsReceived: report.requirementsReceived,
        sourcesFailed: report.sourcesFailed,
      });
    } catch {
      // Do not let database connection strings or vendor payloads escape into
      // persisted logs through an arbitrary thrown error/cause chain.
      console.error("driver curation failed");
      throw new Error("driver curation failed");
    }
  },
};

export { curateDrivers, mergeBatches } from "./curate";
export { CURATION_UPSERT_SQL, persistCurationWith } from "./db";
export * from "./sources";
export type * from "./types";
