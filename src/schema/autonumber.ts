import type pg from "pg";
import { dataTable } from "../db/dataTables.js";
import { query } from "../db/pool.js";
import type { Column, RecordData, TableSchema } from "../types.js";

// "Auto-number" columns: references like INV-0001, given when a record is
// created. Numbers come from the `counters` table, incremented inside the
// insert's transaction. A prefix with {YYYY} restarts numbering every year.

const YEAR_TOKEN = "{YYYY}";
const DIGITS = 4;

const prefixOf = (column: Column) => column.autonumber?.prefix ?? "";
const periodOf = (column: Column, date = new Date()) =>
  prefixOf(column).includes(YEAR_TOKEN) ? String(date.getFullYear()) : "";

// INV-0007, INV-2026-0007; numbers past 9999 simply get longer
export const formatAutonumber = (column: Column, n: number, date = new Date()) =>
  `${prefixOf(column).split(YEAR_TOKEN).join(String(date.getFullYear()))}${String(n).padStart(DIGITS, "0")}`;

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";
export const autonumberColumns = (schema: TableSchema) => schema.columns.filter((c) => c.type === "autonumber");

// Reserve `count` numbers; returns the first.
async function reserve(tableName: string, column: Column, count: number, client: pg.PoolClient) {
  const { rows } = await query<{ first: string }>(
    `INSERT INTO counters (table_name, column_name, period, next) VALUES ($1, $2, $3, 1 + $4)
     ON CONFLICT (table_name, column_name, period) DO UPDATE SET next = counters.next + $4
     RETURNING next - $4 AS first`,
    [tableName, column.name, periodOf(column), count],
    client
  );
  return Number(rows[0].first);
}

// Make sure the next number is past `n` (after records arrived with their own
// numbers, e.g. from a CSV file).
async function bumpPast(tableName: string, column: Column, period: string, n: number, client: pg.PoolClient) {
  await query(
    `INSERT INTO counters (table_name, column_name, period, next) VALUES ($1, $2, $3, $4 + 1)
     ON CONFLICT (table_name, column_name, period) DO UPDATE SET next = GREATEST(counters.next, $4 + 1)`,
    [tableName, column.name, period, n],
    client
  );
}

// The number in a value written with this column's prefix ("INV-0042" -> 42).
function numberIn(column: Column, value: string, date = new Date()): number | null {
  const prefix = prefixOf(column).split(YEAR_TOKEN).join(String(date.getFullYear()));
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  return /^\d{1,15}$/.test(rest) ? Number(rest) : null;
}

// Fill in auto-numbers for new records (in place). Values given on purpose
// (imports, the API) are kept, and the counter moves past them.
export async function assignAutonumbers(schema: TableSchema, records: RecordData[], client: pg.PoolClient) {
  for (const column of autonumberColumns(schema)) {
    const missing = records.filter((r) => isEmpty(r[column.name]));
    const given = records.map((r) => r[column.name]).filter((v): v is string => typeof v === "string" && v !== "");
    const highest = given.reduce((max, v) => Math.max(max, numberIn(column, v) ?? 0), 0);
    if (highest) await bumpPast(schema.tableName, column, periodOf(column), highest, client);
    if (!missing.length) continue;
    const first = await reserve(schema.tableName, column, missing.length, client);
    missing.forEach((r, i) => {
      r[column.name] = formatAutonumber(column, first + i);
    });
  }
}

// A new auto-number column on a table that already has records: number them
// in the order they were created (per year when the prefix has {YYYY}), and
// set the counters to follow on.
export async function backfillAutonumber(tableName: string, column: Column, client: pg.PoolClient) {
  const yearly = prefixOf(column).includes(YEAR_TOKEN);
  const prefix = prefixOf(column);
  const { rows } = await query<{ period: string; last: string }>(
    `WITH numbered AS (
       SELECT _id,
              CASE WHEN $3 THEN extract(year FROM created_at)::int::text ELSE '' END AS period,
              row_number() OVER (
                PARTITION BY CASE WHEN $3 THEN extract(year FROM created_at)::int ELSE 0 END
                ORDER BY created_at, _id) AS n
         FROM ${dataTable(tableName)}
     ),
     updated AS (
       UPDATE ${dataTable(tableName)} t
          SET data = jsonb_set(t.data, ARRAY[$1::text],
                to_jsonb(replace($2, '{YYYY}', numbered.period) ||
                         CASE WHEN numbered.n < 10000 THEN lpad(numbered.n::text, 4, '0') ELSE numbered.n::text END))
         FROM numbered
        WHERE t._id = numbered._id
       RETURNING numbered.period, numbered.n
     )
     SELECT period, max(n)::text AS last FROM updated GROUP BY period`,
    [column.name, prefix, yearly],
    client
  );
  for (const row of rows) await bumpPast(tableName, column, row.period, Number(row.last), client);
}

// After records were written directly (the demo seed): continue numbering
// after the highest number in use.
export async function syncCounterFromData(tableName: string, column: Column, client: pg.PoolClient) {
  const { rows } = await query<{ value: string }>(
    `SELECT t.data ->> $1 AS value FROM ${dataTable(tableName)} t WHERE t.data ->> $1 IS NOT NULL`,
    [column.name],
    client
  );
  const highest = rows.reduce((max, r) => Math.max(max, numberIn(column, r.value) ?? 0), 0);
  if (highest) await bumpPast(tableName, column, periodOf(column), highest, client);
}

export async function deleteCounters(tableName: string, columnName: string, client: pg.PoolClient) {
  await query(`DELETE FROM counters WHERE table_name = $1 AND column_name = $2`, [tableName, columnName], client);
}
