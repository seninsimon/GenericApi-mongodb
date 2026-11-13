import { createHash } from "node:crypto";
import { logger } from "../lib/logger.js";
import { INDEXABLE_TYPES, valueType } from "../schema/columns.js";
import type { Column, TableSchema } from "../types.js";
import { pool, query, query as runQuery, quoteIdent, quoteLiteral, type Db } from "./pool.js";

// Each ERP table is a Postgres table in the erp_data schema. Field values are
// stored as JSONB so columns can change from the UI without migrations;
// department_id says which department a record belongs to, and
// shared_department_ids which other departments may see it too.
export const DATA_SCHEMA = "erp_data";

export const dataTable = (name: string) => `${DATA_SCHEMA}.${quoteIdent(name)}`;

const hash = (value: string, length = 16) =>
  createHash("sha1").update(value).digest("hex").slice(0, length);

const ensured = new Set<string>();

// `db`: run inside the caller's transaction (then not remembered as created
// until the caller calls this again after committing).
export async function ensureDataTable(tableName: string, db?: Db): Promise<void> {
  if (ensured.has(tableName)) return;

  const table = dataTable(tableName);
  const prefix = hash(tableName);
  const query = (sql: string) => runQuery(sql, [], db);

  await query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      _id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      data           JSONB NOT NULL DEFAULT '{}'::jsonb,
      department_id  TEXT REFERENCES departments(_id) ON DELETE SET NULL,
      created_by     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // tables created before departments existed
  await query(`
    ALTER TABLE ${table}
    ADD COLUMN IF NOT EXISTS department_id TEXT REFERENCES departments(_id) ON DELETE SET NULL
  `);
  // "Visible to" several departments (see migrations/009_shared_departments.sql, same index name)
  await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS shared_department_ids TEXT[] NOT NULL DEFAULT '{}'`);
  await query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${createHash("md5").update(tableName).digest("hex").slice(0, 16)}_shareddept_idx`)}
     ON ${table} USING gin (shared_department_ids)`
  );
  // "Created by" (see migrations/003_created_by.sql, which uses the same index name)
  await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${createHash("md5").update(tableName).digest("hex").slice(0, 16)}_createdby_idx`)}
     ON ${table} (created_by)`
  );
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

  if (!db) ensured.add(tableName);
}

// After a table is dropped, so a new table with the same name is set up again.
export const forgetDataTable = (tableName: string) => ensured.delete(tableName);

/* ---------------- sorting & sort indexes ---------------- */

// SQL expression a column is sorted by. Number columns sort numerically; the
// others by text (ISO dates sort correctly as text). Sort indexes are built on
// exactly the same expression, so the planner can use them.
export const sortExpression = (column: Column, alias = "t"): string => {
  const field = `${alias ? `${alias}.` : ""}data ->> ${quoteLiteral(column.name)}`;
  if (column.type === "choice") {
    // in the options' order (To do, Doing, Done); removed options last
    const labels = (column.options ?? []).map((o) => quoteLiteral(o.label)).join(", ");
    return labels ? `array_position(ARRAY[${labels}]::text[], ${field})` : `(${field})`;
  }
  return valueType(column) === "number" ? `erp_try_numeric(${field})` : `(${field})`;
};

const indexNameFor = (tableName: string, column: Column) =>
  `${hash(tableName)}_col_${hash(column.name, 12)}_${valueType(column) === "number" ? "n" : "t"}`;
const linkIndexNameFor = (tableName: string, column: Column) => `${hash(tableName)}_col_${hash(column.name, 12)}_l`;

// Columns that hold ids of linked records or people. They always get an
// index (GIN on the JSON value, single id or list), used by link filters,
// "related records" and "Own only": `data -> col ?| ids` / `@> id`.
const LINK_TYPES = ["relation", "user"];

// Create/drop indexes so they match the columns: sort indexes for columns
// marked "indexed", link indexes for link and person columns.
// Uses CONCURRENTLY so big tables stay writable while an index builds.
export async function syncColumnIndexes(schema: TableSchema): Promise<void> {
  const table = dataTable(schema.tableName);
  const prefix = `${hash(schema.tableName)}_col_`;

  const wanted = new Map<string, string>(); // index name -> indexed expression
  for (const column of schema.columns) {
    if (column.indexed && INDEXABLE_TYPES.includes(column.type)) {
      wanted.set(indexNameFor(schema.tableName, column), `(${sortExpression(column, "")})`);
    }
    if (LINK_TYPES.includes(column.type)) {
      wanted.set(linkIndexNameFor(schema.tableName, column), `USING gin ((data -> ${quoteLiteral(column.name)}))`);
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
  for (const [name, expression] of wanted) {
    if (present.has(name)) continue;
    await pool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(name)} ON ${table} ${expression}`);
    logger.info({ table: schema.tableName, index: name }, "created index");
  }
}
