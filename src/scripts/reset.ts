// Wipe ALL data: every table and record, users, roles, departments, installed
// apps, automations, notifications, audit log, jobs, sessions and every
// uploaded file. Then the schema is recreated and the
// first admin account is created again from ADMIN_USERNAME / ADMIN_PASSWORD.
//
//   pnpm db:reset              (asks you to type RESET)
//   pnpm db:reset --yes        (no question; for scripts)
//   docker compose exec api node dist/scripts/reset.js --yes --force
//
// In production (NODE_ENV=production, e.g. inside docker) --force is required too.
// Restart the API afterwards so it drops its caches.
import { createInterface } from "node:readline/promises";
import { ensureInitialAdmin } from "../auth/bootstrap.js";
import { env } from "../config/env.js";
import { migrate } from "../db/migrate.js";
import { pool } from "../db/pool.js";
import { storage } from "../storage.js";

const args = new Set(process.argv.slice(2));

// Everything this app creates (and nothing else in the database).
const SYSTEM_TABLES = [
  "audit_log",
  "jobs",
  "login_attempts",
  "sessions",
  "user_departments",
  "table_departments",
  "users",
  "roles",
  "departments",
  "table_schemas",
  "counters",
  "installed_apps",
  "notifications",
  "automations",
  "schema_migrations",
];

async function confirm(): Promise<boolean> {
  if (env.isProduction && !args.has("--force")) {
    console.error("Refusing to reset a production database without --force.");
    return false;
  }
  if (args.has("--yes")) return true;

  const db = new URL(env.databaseUrl).pathname.slice(1);
  console.log(`\nThis permanently deletes ALL data in database "${db}" and ALL files in bucket "${env.s3.bucket}":`);
  console.log("tables and records, users, roles, departments, apps, automations, notifications, audit log, jobs and uploads.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type RESET to continue: ');
  rl.close();
  return answer.trim() === "RESET";
}

async function main() {
  if (!(await confirm())) {
    console.log("Nothing was changed.");
    return;
  }

  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'erp_data'`
  );

  await pool.query("BEGIN");
  try {
    await pool.query("DROP SCHEMA IF EXISTS erp_data CASCADE");
    await pool.query(`DROP TABLE IF EXISTS ${SYSTEM_TABLES.join(", ")} CASCADE`);
    await pool.query("DROP FUNCTION IF EXISTS erp_search_text(jsonb), erp_try_numeric(text), erp_try_date(text)");
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
  console.log(`Dropped ${rows[0].n} data table(s) and all system tables.`);

  await storage.init();
  const files = await storage.clear();
  console.log(`Deleted ${files} stored file(s).`);

  await migrate();
  await ensureInitialAdmin();
  // tell running API/worker instances to drop their schema caches
  await pool.query("SELECT pg_notify('erp_schema_changed', '')");

  console.log(`\nDone. Log in as "${env.adminUsername}". Restart the API (and worker) to clear their caches.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
