import type pg from "pg";
import { dataTable } from "../db/dataTables.js";
import { query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import type { Column, RecordData, TableSchema } from "../types.js";
import { valueType } from "./columns.js";
import { applyFormulas, checkFormulas } from "./formula.js";
import { getAllSchemas, getSchema } from "./schemaRepo.js";

// Roll-up columns: totals over linked records ("Hours" on a project = the sum
// of its time logs' hours). The SQL lives in formula.ts (compileRollup); this
// file checks roll-up settings and keeps stored totals current when the
// linked records change.

const label = (c: Column) => c.label || c.name;
const MAX_DEPTH = 5;

// Columns of another table, for checking: the table being saved itself,
// tables created in the same step, or stored ones.
export type ColumnsOf = (tableName: string) => Promise<Column[] | null>;
const storedColumns: ColumnsOf = async (name) => (await getSchema(name))?.columns ?? null;

// Check every roll-up of a table (being created or changed) and work out its
// result type (in place). Throws a readable 400 on the first problem.
export async function checkRollups(tableName: string, columns: Column[], columnsOf: ColumnsOf = storedColumns) {
  for (const column of columns.filter((c) => c.type === "rollup")) {
    const r = column.rollup!;
    const what = `Total "${label(column)}"`;
    const child = r.from === tableName ? columns : await columnsOf(r.from);
    if (!child) throw new HttpError(400, `${what}: the table "${r.from}" doesn't exist`);
    const via = child.find((c) => c.name === r.via);
    if (!via || via.type !== "relation" || via.ref !== tableName) {
      throw new HttpError(400, `${what}: "${r.from}" has no link column "${r.via}" to this table`);
    }
    if (r.fn === "count") r.type = "number";
    else {
      const field = child.find((c) => c.name === r.field);
      // a formula on the other table that isn't checked yet (both made together)
      if (field?.type === "formula" && !field.formula?.type) {
        try {
          checkFormulas(child);
        } catch {
          // reported when that table itself is saved
        }
      }
      const type = field && valueType(field);
      if (!field) throw new HttpError(400, `${what}: "${r.from}" has no column "${r.field}"`);
      if (r.fn === "sum" || r.fn === "avg") {
        if (type !== "number") throw new HttpError(400, `${what}: only numbers can be added up ("${label(field)}" isn't one)`);
        r.type = "number";
      } else {
        if (type !== "number" && type !== "date") {
          throw new HttpError(400, `${what}: lowest/highest needs a number or a date ("${label(field)}" is neither)`);
        }
        r.type = type;
      }
    }
    if (r.where && !child.some((c) => c.name === r.where!.column)) {
      throw new HttpError(400, `${what}: "${r.from}" has no column "${r.where.column}"`);
    }
  }
}

// Roll-ups elsewhere that total records of `tableName` (optionally: ones that
// use this column of it). Used to refresh them and to refuse deleting what
// they need.
export async function rollupsOver(tableName: string, columnName?: string) {
  return (await getAllSchemas()).flatMap((schema) =>
    schema.columns
      .filter((c) => c.type === "rollup" && c.rollup?.from === tableName)
      .filter(
        (c) =>
          !columnName ||
          c.rollup!.via === columnName ||
          c.rollup!.field === columnName ||
          c.rollup!.where?.column === columnName
      )
      .map((column) => ({ schema, column }))
  );
}

// "“Hours” on Projects totals it": refuse deleting a table or column a
// roll-up needs (it would make the parent table's saves fail).
export async function assertNotUsedByRollups(tableName: string, columnName?: string) {
  const users = (await rollupsOver(tableName, columnName)).filter((u) => !columnName || u.schema.tableName !== tableName || u.column.name !== columnName);
  if (users.length) {
    const { schema, column } = users[0];
    throw new HttpError(
      400,
      `The total "${label(column)}" in ${schema.tableName} uses ${columnName ? "this column" : "this table"}. Change or delete that column first.`
    );
  }
}

const idsIn = (value: unknown): string[] =>
  ([] as unknown[]).concat(value ?? []).filter((v): v is string => typeof v === "string" && v.length > 0);

// After records of `tableName` changed (created, edited, moved, deleted):
// work out again the roll-ups of the records they link to, and upwards
// (a time log -> its task's hours -> the project's hours).
// `rows`: the records' data before and/or after the change.
export async function refreshParents(tableName: string, rows: RecordData[], client: pg.PoolClient, depth = 0) {
  if (depth >= MAX_DEPTH || !rows.length) return;
  const byParent = new Map<string, { schema: TableSchema; ids: Set<string> }>();
  for (const { schema, column } of await rollupsOver(tableName)) {
    const entry = byParent.get(schema.tableName) ?? { schema, ids: new Set<string>() };
    for (const row of rows) for (const id of idsIn(row[column.rollup!.via])) entry.ids.add(id);
    byParent.set(schema.tableName, entry);
  }
  for (const { schema, ids } of byParent.values()) {
    if (!ids.size) continue;
    await applyFormulas(schema, [...ids], client);
    // their own parents
    const { rows: changed } = await query<{ data: RecordData }>(
      `SELECT data FROM ${dataTable(schema.tableName)} WHERE _id = ANY($1::text[])`,
      [[...ids]],
      client
    );
    await refreshParents(schema.tableName, changed.map((r) => r.data), client, depth + 1);
  }
}

// After a table's columns changed (or many records at once): every roll-up
// over it, everywhere.
export async function refreshAllParents(tableName: string, client: pg.PoolClient, depth = 0) {
  if (depth >= MAX_DEPTH) return;
  const parents = new Map((await rollupsOver(tableName)).map((u) => [u.schema.tableName, u.schema]));
  for (const schema of parents.values()) {
    if (schema.tableName === tableName && depth > 0) continue;
    await applyFormulas(schema, null, client);
    if (schema.tableName !== tableName) await refreshAllParents(schema.tableName, client, depth + 1);
  }
}
