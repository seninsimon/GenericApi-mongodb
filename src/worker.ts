import { pool } from "./db/pool.js";
import { startWorker } from "./jobs/worker.js";
import { logger } from "./lib/logger.js";
import { prepare } from "./startup.js";

// Standalone background-job worker (docker "worker" service).
try {
  const stopListener = await prepare();
  const stopWorker = await startWorker();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker shutting down (finishing the current job)");
    await stopWorker();
    await stopListener();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} catch (err) {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
}
