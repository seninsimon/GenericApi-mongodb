import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { loadDraftedApps } from "./apps/draft.js";
import { ensureAppRoles, upgradeInstalledApps } from "./apps/installer.js";
import { importAiSettingsFromEnv } from "./ai/settings.js";
import { importMailSettingsFromEnv } from "./controllers/email.js";
import { startWorker } from "./jobs/worker.js";
import { logger } from "./lib/logger.js";
import { prepare } from "./startup.js";
import { startLiveListener } from "./live/events.js";

try {
  const stopListener = await prepare();
  // live updates: one LISTEN connection, passed on to open browser tabs
  const stopLive = await startLiveListener();
  // apps installed before apps had their own roles get them (once)
  await loadDraftedApps();
  const added = await ensureAppRoles();
  if (added) logger.info({ apps: added }, "gave installed apps their own roles");
  // installed apps whose blueprint got newer: their new and corrected automations
  const upgraded = await upgradeInstalledApps();
  if (upgraded.length) logger.info({ apps: upgraded }, "updated installed apps");
  // email settings put in .env fill Administration → Email once
  await importMailSettingsFromEnv();
  // and an ANTHROPIC_API_KEY fills Administration → AI once
  await importAiSettingsFromEnv();
  // in docker a separate "worker" service runs jobs (RUN_WORKER=false here)
  const stopWorker = env.runWorker ? await startWorker() : null;

  const server = createApp().listen(env.port, () => logger.info(`API listening on port ${env.port}`));
  server.keepAliveTimeout = 65_000; // longer than typical proxy idle timeouts

  // graceful shutdown: stop taking requests, finish the current job, close the pool
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopWorker?.();
    await stopLive();
    await stopListener();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
} catch (err) {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
}
