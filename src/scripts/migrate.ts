// Apply pending database migrations (also done automatically on start-up):
//
//   pnpm migrate
//   docker compose run --rm api node dist/scripts/migrate.js
import { migrate } from "../db/migrate.js";
import { pool } from "../db/pool.js";
import { ensureAllDataTables } from "../schema/schemaRepo.js";

await migrate();
await ensureAllDataTables();
console.log("Database is up to date.");
await pool.end();
