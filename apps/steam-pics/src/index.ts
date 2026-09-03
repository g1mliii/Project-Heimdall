import { collectOnce, summarise } from "./collect.js";
import { executorFor } from "./db.js";
import { connectAnonymously } from "./steam.js";

/**
 * One PICS collection cycle, then exit (§8.8b).
 *
 * A job, not a service. Anonymous login measures well under a second, and the
 * full refresh in `collectOnce` is what makes correctness independent of run
 * cadence — so this is scheduled rather than kept alive, and needs no
 * always-on host.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const execute = executorFor(databaseUrl);
  const client = await connectAnonymously();
  try {
    const report = await collectOnce({ execute, client });
    console.info("pics collection complete", {
      appsQueried: report.appsQueried,
      changedAppsSeen: report.changedAppsSeen,
      buildsNew: report.builds.inserted,
      depotsNew: report.depots.inserted,
      manifestsNew: report.manifests.inserted,
      cursor: report.cursor,
      batchesFailed: report.batchesFailed,
    });
    // A run where every batch failed produced no data and must not look green.
    if (report.batchesFailed > 0 && report.builds.inserted + report.builds.refreshed === 0) {
      throw new Error("every product-info batch failed");
    }
  } finally {
    client.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("pics collection failed:", summarise(error));
    process.exit(1);
  });
