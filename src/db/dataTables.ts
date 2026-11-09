import { createHash } from "node:crypto";
import { logger } from "../lib/logger.js";
import { INDEXABLE_TYPES } from "../schema/columns.js";
import type { Column, TableSchema } from "../types.js";
import { pool, query, quoteIdent, quoteLiteral } from "./pool.js";

// Each ERP table is a Postgres table in the erp_data schema. Field values are
// stored as JSONB so columns can change from the UI without migrations;
// department_id says which department a record belongs to.
export const DATA_SCHEMA = "erp_data";

export const dataTable = (name: string) => `${DATA_SCHEMA}.${quoteIdent(name)}`;

const hash = (value: string, length = 16) =>
  createHash("sha1").update(value).digest("hex").slice(0, length);

const ensured = new Set<string>();

export async function ensureDataTable(tableName: string): Promise<void> {
  if (ensured.has(tableName)) return;

  const table = dataTable(tableName);
  const prefix = hash(tableName);

  await query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      _id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      data           JSONB NOT NULL DEFAULT '{}'::jsonb,
      department_id  TEXT REFERENCES departments(_id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // tables created before departments existed
  await query(`
    ALTER TABLE ${table}
    ADD COLUMN IF NOT EXISTS department_id TEXT REFERENCES departments(_id) ON DELETE SET NULL
  `);
  // (20-character prefix: the name used before, so existing tables keep one index)
  await query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${hash(tableName, 20)}_department_idx`)} ON ${table} (department_id)`
  );
  // default list order (newest first) and keyset scans for exports
  await query(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`${prefix}_created_idx`)} ON ${table} (created_at, _id)`);
  // "contains" search over all values
  await query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${prefix}_search_idx`)}
     ON ${table} USING gin (erp_search_text(data) gin_trgm_ops)`
  );

  ensured.add(tableName);
}

// After a table is dropped, so a new table with the same name is set up again.
export const forgetDataTable = (tableName: string) => ensured.delete(tableName);

/* ---------------- sorting & sort indexes ---------------- */

// SQL expression a column is sorted by. Number columns sort numerically; the
// others by text (ISO dates sort correctly as text). Sort indexes are built on
// exactly the same expression, so the planner can use them.
export const sortExpression = (column: Column, alias = "t"): string => {
  const field = `${alias ? `${alias}.` : ""}data ->> ${quoteLiteral(column.name)}`;
  return column.type === "number" ? `erp_try_numeric(${field})` : `(${field})`;
};

const indexNameFor = (tableName: string, column: Column) =>
  `${hash(tableName)}_col_${hash(column.name, 12)}_${column.type === "number" ? "n" : "t"}`;

// Create/drop sort indexes so they match the columns marked "indexed".
// Uses CONCURRENTLY so big tables stay writable while an index builds.
export async function syncColumnIndexes(schema: TableSchema): Promise<void> {
  const table = dataTable(schema.tableName);
  const prefix = `${hash(schema.tableName)}_col_`;

  const wanted = new Map<string, Column>();
  for (const column of schema.columns) {
    if (column.indexed && INDEXABLE_TYPES.includes(column.type)) {
      wanted.set(indexNameFor(schema.tableName, column), column);
    }
  }

  const { rows: existing } = await query<{ indexname: string; valid: boolean }>(
    `SELECT i.relname AS indexname, x.indisvalid AS valid
     FROM pg_index x
     JOIN pg_class i ON i.oid = x.indexrelid
     WHERE x.indrelid = to_regclass($1) AND i.relname LIKE $2`,
    [table, `${prefix}%`]
  );

  for (const { indexname, valid } of existing) {
    // drop indexes no longer wanted, and broken ones left by a failed build
    if (!wanted.has(indexname) || !valid) {
      await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${DATA_SCHEMA}.${quoteIdent(indexname)}`);
      if (valid) logger.info({ table: schema.tableName, index: indexname }, "dropped sort index");
    }
  }

  const present = new Set(existing.filter((e) => e.valid).map((e) => e.indexname));
  for (const [name, column] of wanted) {
    if (present.has(name)) continue;
    await pool.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(name)} ON ${table} (${sortExpression(column, "")})`
    );
    logger.info({ table: schema.tableName, column: column.name }, "created sort index");
  }
}
