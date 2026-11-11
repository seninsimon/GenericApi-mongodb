import { env } from "../config/env.js";
import { dataTable, ensureDataTable, sortExpression } from "../db/dataTables.js";
import { isMissingTable, query, type Db } from "../db/pool.js";
import { filterConditions, type RecordFilter } from "../schema/filters.js";
import type { Column, RecordData, StoredRecord, TableSchema } from "../types.js";

// SQL condition limiting records to departmentIds (null = no limit, for admins).
const departmentScope = (params: unknown[], departmentIds: string[] | null, alias = "t") => {
  if (departmentIds == null) return "TRUE";
  params.push(departmentIds);
  return `${alias}.department_id = ANY($${params.length}::text[])`;
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

type Row = {
  _id: string;
  data: RecordData;
  department_id: string | null;
  created_by?: string | null;
  created_at?: Date;
  updated_at?: Date;
};
const toStored = (row: Row): StoredRecord => ({
  _id: row._id,
  data: row.data,
  departmentId: row.department_id,
  createdBy: row.created_by ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// WHERE conditions shared by lists and exports: department scope, search, filters.
export function recordConditions(
  schema: TableSchema,
  opts: { departmentIds: string[] | null; search?: string; filters?: RecordFilter[] },
  params: unknown[]
): string {
  const conditions = [departmentScope(params, opts.departmentIds)];
  // "contains" search over all values (GIN trigram index on erp_search_text)
  if (opts.search) {
    params.push(`%${escapeLike(opts.search)}%`);
    conditions.push(`erp_search_text(t.data) ILIKE $${params.length}`);
  }
  conditions.push(...filterConditions(schema, opts.filters ?? [], params));
  return conditions.join(" AND ");
}

// Missing table = nothing stored yet.
async function orEmpty<T>(fn: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isMissingTable(error)) return empty;
    throw error;
  }
}

export interface ListOptions {
  search?: string;
  filters?: RecordFilter[];
  // a column, or a system field ("_createdAt" / "_updatedAt")
  sort?: Column | "_createdAt" | "_updatedAt" | null;
  order?: "asc" | "desc";
  page: number;
  limit: number;
  departmentIds: string[] | null;
}

export interface ListResult {
  rows: (StoredRecord & { departmentName: string | null })[];
  total: number;
  totalIsEstimate: boolean;
}

export async function listRecords(schema: TableSchema, options: ListOptions): Promise<ListResult> {
  const table = dataTable(schema.tableName);
  const params: unknown[] = [];
  const where = `WHERE ${recordConditions(schema, options, params)}`;

  const direction = options.order === "asc" ? "ASC" : "DESC";
  // Typed sort expression; matches the column's sort index when it has one.
  // Postgres' default NULL order (last for ASC, first for DESC) is kept on
  // purpose: an explicit NULLS LAST on DESC would stop the index being used.
  const sort = options.sort;
  const orderBy =
    sort === "_updatedAt"
      ? `t.updated_at ${direction}, t._id ${direction}`
      : sort && sort !== "_createdAt"
        ? `${sortExpression(sort)} ${direction}, t.created_at ${direction}, t._id ${direction}`
        : `t.created_at ${direction}, t._id ${direction}`;

  return orEmpty(async () => {
    const { total, totalIsEstimate } = await countRecords(table, where, params);
    const offset = (options.page - 1) * options.limit;
    const { rows } = await query<Row & { department_name: string | null }>(
      `SELECT t._id, t.data, t.department_id, t.created_by, t.created_at, t.updated_at, d.name AS department_name
       FROM ${table} t
       LEFT JOIN departments d ON d._id = t.department_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, options.limit, offset]
    );
    return {
      rows: rows.map((r) => ({ ...toStored(r), departmentName: r.department_name })),
      total,
      totalIsEstimate,
    };
  }, { rows: [], total: 0, totalIsEstimate: false });
}

// Exact count for normal tables; the planner's estimate for very large ones,
// where count(*) would read every matching row on each page load.
async function countRecords(table: string, where: string, params: unknown[]) {
  const { rows: size } = await query<{ estimate: number }>(
    `SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = to_regclass($1)`,
    [table]
  );
  if (Number(size[0]?.estimate ?? 0) > env.exactCountLimit) {
    const { rows } = await query<{ "QUERY PLAN": { Plan: { "Plan Rows": number } }[] }>(
      `EXPLAIN (FORMAT JSON) SELECT 1 FROM ${table} t ${where}`,
      params
    );
    return { total: Math.round(rows[0]["QUERY PLAN"][0].Plan["Plan Rows"]), totalIsEstimate: true };
  }
  const { rows } = await query<{ total: number }>(`SELECT count(*)::int AS total FROM ${table} t ${where}`, params);
  return { total: rows[0].total, totalIsEstimate: false };
}

export const getRecordsByIds = (tableName: string, ids: string[], departmentIds: string[] | null) =>
  ids.length
    ? orEmpty(async () => {
        const params: unknown[] = [ids];
        const { rows } = await query<Row>(
          `SELECT t._id, t.data, t.department_id FROM ${dataTable(tableName)} t
           WHERE t._id = ANY($1::text[]) AND ${departmentScope(params, departmentIds)}`,
          params
        );
        return rows.map(toStored);
      }, [] as StoredRecord[])
    : Promise.resolve([] as StoredRecord[]);

// Relation dropdown options: specific ids, or up to `limit` matches of `search`.
export function getRecordOptions(
  tableName: string,
  displayField: string,
  opts: { search?: string; ids?: string[]; limit: number; departmentIds: string[] | null }
) {
  return orEmpty(async () => {
    const params: unknown[] = [displayField];
    const label = `CASE WHEN $1 = '_id' THEN t._id ELSE t.data ->> $1 END`;
    const conditions = [departmentScope(params, opts.departmentIds)];

    if (opts.ids?.length) {
      params.push(opts.ids);
      conditions.push(`t._id = ANY($${params.length}::text[])`);
    } else if (opts.search) {
      params.push(`%${escapeLike(opts.search)}%`);
      // the trigram index narrows the rows, the label check makes it exact
      conditions.push(`erp_search_text(t.data) ILIKE $${params.length} AND (${label}) ILIKE $${params.length}`);
    }

    params.push(opts.ids?.length ? opts.ids.length : opts.limit);
    const { rows } = await query<{ _id: string; label: string | null }>(
      `SELECT t._id, ${label} AS label FROM ${dataTable(tableName)} t
       WHERE ${conditions.join(" AND ")}
       ORDER BY label NULLS LAST, t.created_at
       LIMIT $${params.length}`,
      params
    );
    return rows.map((r) => ({ value: r._id, label: r.label || r._id }));
  }, [] as { value: string; label: string }[]);
}

// Records whose display field equals one of `labels` (imports match relations by label).
export const findByLabels = (
  tableName: string,
  displayField: string,
  labels: string[],
  departmentIds: string[] | null
) =>
  labels.length
    ? orEmpty(async () => {
        const params: unknown[] = [displayField, labels];
        const { rows } = await query<{ _id: string; label: string }>(
          `SELECT t._id, t.data ->> $1 AS label FROM ${dataTable(tableName)} t
           WHERE t.data ->> $1 = ANY($2::text[]) AND ${departmentScope(params, departmentIds)}`,
          params
        );
        return rows;
      }, [] as { _id: string; label: string }[])
    : Promise.resolve([] as { _id: string; label: string }[]);

export const getRecord = (tableName: string, id: string, departmentIds: string[] | null, db?: Db) =>
  orEmpty(async () => {
    const params: unknown[] = [id];
    const { rows } = await query<Row & { department_name: string | null }>(
      `SELECT t._id, t.data, t.department_id, t.created_by, t.created_at, t.updated_at, d.name AS department_name
       FROM ${dataTable(tableName)} t LEFT JOIN departments d ON d._id = t.department_id
       WHERE t._id = $1 AND ${departmentScope(params, departmentIds)}`,
      params,
      db
    );
    return rows[0] ? { ...toStored(rows[0]), departmentName: rows[0].department_name } : null;
  }, null as (StoredRecord & { departmentName: string | null }) | null);

export async function insertRecord(
  tableName: string,
  data: RecordData,
  departmentId: string | null,
  createdBy: string | null,
  db?: Db
) {
  await ensureDataTable(tableName);
  const { rows } = await query<{ _id: string }>(
    `INSERT INTO ${dataTable(tableName)} (data, department_id, created_by) VALUES ($1::jsonb, $2, $3) RETURNING _id`,
    [JSON.stringify(data), departmentId, createdBy],
    db
  );
  return rows[0]._id;
}

// Insert many validated records at once (imports).
export async function insertRecords(
  tableName: string,
  records: { data: RecordData; departmentId: string | null }[],
  createdBy: string | null,
  db?: Db
) {
  if (!records.length) return 0;
  await ensureDataTable(tableName);
  const { rowCount } = await query(
    `INSERT INTO ${dataTable(tableName)} (data, department_id, created_by)
     SELECT d, dep, $3 FROM unnest($1::jsonb[], $2::text[]) AS r(d, dep)`,
    [records.map((r) => JSON.stringify(r.data)), records.map((r) => r.departmentId), createdBy],
    db
  );
  return rowCount ?? 0;
}

// Merge `data` into a record (only within departmentIds). newDepartmentId:
// undefined = keep. Returns the record before the change, or null.
export async function updateRecord(
  tableName: string,
  id: string,
  data: RecordData,
  opts: { departmentIds: string[] | null; newDepartmentId?: string | null },
  db?: Db
) {
  const table = dataTable(tableName);
  return orEmpty(async () => {
    const params: unknown[] = [id, JSON.stringify(data), opts.newDepartmentId !== undefined, opts.newDepartmentId ?? null];
    const { rows } = await query<{ old_data: RecordData; old_department: string | null }>(
      `UPDATE ${table} AS t
       SET data = t.data || $2::jsonb,
           department_id = CASE WHEN $3 THEN $4 ELSE t.department_id END,
           updated_at = now()
       FROM (
         SELECT t._id, t.data, t.department_id FROM ${table} t
         WHERE t._id = $1 AND ${departmentScope(params, opts.departmentIds)}
         FOR UPDATE
       ) AS old
       WHERE t._id = old._id
       RETURNING old.data AS old_data, old.department_id AS old_department`,
      params,
      db
    );
    return rows[0] ? { data: rows[0].old_data, departmentId: rows[0].old_department } : null;
  }, null);
}

// Lock and read a record before an update (for validation against the merged result).
export const lockRecord = (tableName: string, id: string, departmentIds: string[] | null, db: Db) =>
  orEmpty(async () => {
    const params: unknown[] = [id];
    const { rows } = await query<Row>(
      `SELECT t._id, t.data, t.department_id FROM ${dataTable(tableName)} t
       WHERE t._id = $1 AND ${departmentScope(params, departmentIds)} FOR UPDATE`,
      params,
      db
    );
    return rows[0] ? toStored(rows[0]) : null;
  }, null as StoredRecord | null);

export const deleteRecord = (tableName: string, id: string, departmentIds: string[] | null, db?: Db) =>
  orEmpty(async () => {
    const params: unknown[] = [id];
    const { rows } = await query<Row>(
      `DELETE FROM ${dataTable(tableName)} t
       WHERE t._id = $1 AND ${departmentScope(params, departmentIds)}
       RETURNING t._id, t.data, t.department_id`,
      params,
      db
    );
    return rows[0] ? toStored(rows[0]) : null;
  }, null as StoredRecord | null);

export const countUnassigned = (tableName: string) =>
  orEmpty(async () => {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${dataTable(tableName)} WHERE department_id IS NULL`
    );
    return rows[0].n;
  }, 0);

export const assignUnassigned = (tableName: string, departmentId: string) =>
  orEmpty(async () => {
    const { rowCount } = await query(
      `UPDATE ${dataTable(tableName)} SET department_id = $1, updated_at = now() WHERE department_id IS NULL`,
      [departmentId]
    );
    return rowCount ?? 0;
  }, 0);

// Read a table in batches in insertion order (exports), within departmentIds.
export async function* scanRecords(
  schema: TableSchema,
  opts: { departmentIds: string[] | null; search?: string; filters?: RecordFilter[] },
  batchSize = 1000
) {
  const tableName = schema.tableName;
  let after: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const params: unknown[] = [];
    const conditions = [recordConditions(schema, opts, params)];
    if (after) {
      params.push(after.createdAt, after.id);
      conditions.push(`(t.created_at, t._id) > ($${params.length - 1}, $${params.length})`);
    }
    params.push(batchSize);
    const rows: (Row & { created_at: Date; department_name: string | null })[] = await orEmpty(
      async () =>
        (
          await query<Row & { created_at: Date; department_name: string | null }>(
            `SELECT t._id, t.data, t.department_id, t.created_by, t.created_at, d.name AS department_name
             FROM ${dataTable(tableName)} t LEFT JOIN departments d ON d._id = t.department_id
             WHERE ${conditions.join(" AND ")}
             ORDER BY t.created_at, t._id
             LIMIT $${params.length}`,
            params
          )
        ).rows,
      []
    );
    if (!rows.length) return;
    yield rows.map((r) => ({ ...toStored(r), departmentName: r.department_name }));
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1];
    after = { createdAt: last.created_at, id: last._id };
  }
}
