import { ensureInitialAdmin } from "./auth/bootstrap.js";
import { env } from "./config/env.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { logger } from "./lib/logger.js";
import { ensureAllDataTables, startSchemaListener } from "./schema/schemaRepo.js";
import { storage } from "./storage.js";

// Shared start-up for the API and the worker.
export async function prepare({ listenForSchemaChanges = true } = {}) {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is not set");
  if (env.isProduction) {
    if (!env.cookieSecure) logger.warn("COOKIE_SECURE is false: serve the app over HTTPS and set it to true");
    if (env.s3.secretKey === "erp-storage-secret") logger.warn("S3_SECRET_KEY is the default value: change it");
  }

  await pool.query("SELECT 1");
  await migrate();
  await ensureAllDataTables();
  await storage.init();
  await ensureInitialAdmin();
  const stopListener = listenForSchemaChanges ? await startSchemaListener() : async () => {};
  logger.info("database and storage ready");
  return stopListener;
}
