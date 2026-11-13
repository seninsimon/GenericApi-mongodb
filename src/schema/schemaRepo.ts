import pg from "pg";
import { env } from "../config/env.js";
import { dataTable, ensureDataTable, forgetDataTable, syncColumnIndexes } from "../db/dataTables.js";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { removeTableFromRoles } from "../repo/userRepo.js";
import type { Column, TableSchema } from "../types.js";
import { backfillAutonumber, deleteCounters } from "./autonumber.js";
import { distinctTextValues, rewriteChoiceValues } from "./choiceValues.js";
import { applyFormulas, checkFormulas, formulaRefs } from "./formula.js";
import { assertNotUsedByRollups, checkRollups, refreshAllParents } from "./rollups.js";
import { applyColumnUpdate, normalizeColumn, validateTableName } from "./columns.js";

/* ============================ cache ============================ */
// Schemas are read on almost every request, so they're cached per process.
// Changes are broadcast with NOTIFY so every API/worker instance drops its copy;
// a TTL is the safety net if a notification is ever missed.

const CHANNEL = "erp_schema_changed";
const TTL_MS = 60_000;

let cache: Map<string, TableSchema> | null = null;
let loadedAt = 0;
let loading: Promise<Map<string, TableSchema>> | null = null;

type SchemaRow = {
  _id: string;
  table_name: string;
  columns: (Partial<Column> & Record<string, unknown>)[];
  show_in_menu: boolean;
  by_department: boolean;
  blueprint_key: string | null;
  app_key: string | null;
  departments: { _id: string; name: string }[];
  created_at: Date;
  updated_at: Date;
};

const toSchema = (row: SchemaRow): TableSchema => ({
  _id: row._id,
  tableName: row.table_name,
  // older stored columns may lack newer fields (required, indexed)
  columns: row.columns.map((c) => normalizeColumn(c, { strict: false })),
  showInMenu: row.show_in_menu,
  departments: row.departments ?? [],
  byDepartment: row.by_department ?? true,
  blueprintKey: row.blueprint_key ?? null,
  appKey: row.app_key ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

async function loadAll(): Promise<Map<string, TableSchema>> {
  const { rows } = await query<SchemaRow>(`
    SELECT s.*,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('_id', d._id, 'name', d.name) ORDER BY d.name)
        FROM table_departments td JOIN departments d ON d._id = td.department_id
        WHERE td.table_name = s.table_name
      ), '[]'::jsonb) AS departments
    FROM table_schemas s
    ORDER BY s.created_at, s._id
  `);
  return new Map(rows.map((r) => [r.table_name, toSchema(r)]));
}

async function schemas(): Promise<Map<string, TableSchema>> {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  loading ??= loadAll()
    .then((map) => {
      cache = map;
      loadedAt = Date.now();
      return map;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export const getAllSchemas = async (): Promise<TableSchema[]> => [...(await schemas()).values()];
// The cached schema, without waiting (null before the first load). For code
// that can't be async, e.g. building a record scope; a slightly stale copy is fine.
export const peekSchema = (tableName: string): TableSchema | null => cache?.get(tableName) ?? null;
export const getSchema = async (tableName: string): Promise<TableSchema | null> =>
  (await schemas()).get(tableName) ?? null;

// Call after any change to schemas, table departments or department names.
export async function invalidateSchemas(): Promise<void> {
  cache = null;
  await query(`SELECT pg_notify($1, '')`, [CHANNEL]).catch((err) => logger.warn({ err }, "schema notify failed"));
}

// Listen for changes made by other instances (reconnects on failure).
export async function startSchemaListener(): Promise<() => Promise<void>> {
  let client: pg.Client | null = null;
  let stopped = false;

  const connect = async () => {
    if (stopped) return;
    try {
      client = new pg.Client({ connectionString: env.databaseUrl });
      client.on("notification", () => {
        cache = null;
      });
      client.on("error", (err) => {
        logger.warn({ err }, "schema listener lost connection, reconnecting");
        cache = null;
        client?.end().catch(() => {});
        setTimeout(connect, 2000);
      });
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      logger.warn({ err }, "schema listener failed to connect, retrying");
      setTimeout(connect, 5000);
    }
  };
  await connect();

  return async () => {
    stopped = true;
    await client?.end().catch(() => {});
  };
}

/* ============================ changes ============================ */

// byDepartment: "who sees the records" (see TableSchema); true when not given
export async function createTable(input: { tableName: unknown; columns?: unknown[]; showInMenu?: boolean; byDepartment?: unknown }) {
  const tableName = validateTableName(input.tableName);
  const columns = (input.columns ?? []).map((c) => normalizeColumn(c as Record<string, unknown>));
  await checkRollups(tableName, columns);
  checkFormulas(columns);
  if (await getSchema(tableName)) throw new HttpError(409, "Table already exists");

  await ensureDataTable(tableName);
  try {
    await query(`INSERT INTO table_schemas (table_name, columns, show_in_menu, by_department) VALUES ($1, $2::jsonb, $3, $4)`, [
      tableName,
      JSON.stringify(columns),
      input.showInMenu ?? true,
      typeof input.byDepartment === "boolean" ? input.byDepartment : true,
    ]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new HttpError(409, "Table already exists");
    throw error;
  }
  await invalidateSchemas();
  const schema = (await getSchema(tableName))!;
  await syncColumnIndexes(schema);
  return schema;
}

// Read-modify-write of a table's column list, with the row locked.
// `afterWrite` runs in the same transaction (e.g. to update stored values).
async function changeColumns(
  tableName: string,
  change: (columns: Column[]) => Column[],
  afterWrite?: (client: pg.PoolClient) => Promise<void>
): Promise<TableSchema> {
  await withTransaction(async (client) => {
    const { rows } = await query<{ columns: Record<string, unknown>[] }>(
      `SELECT columns FROM table_schemas WHERE table_name = $1 FOR UPDATE`,
      [tableName],
      client
    );
    if (!rows[0]) throw new HttpError(404, "Table not found");
    const current = rows[0].columns.map((c) => normalizeColumn(c, { strict: false }));
    const next = change(current);
    // every roll-up and formula still works with the new columns (and gets its result type)
    await checkRollups(tableName, next);
    checkFormulas(next);
    await query(
      `UPDATE table_schemas SET columns = $2::jsonb, updated_at = now() WHERE table_name = $1`,
      [tableName, JSON.stringify(next)],
      client
    );
    await afterWrite?.(client);
    // a column change can change formula results: work them out again, and
    // totals elsewhere over this table
    await applyFormulas({ tableName, columns: next } as TableSchema, null, client);
    await refreshAllParents(tableName, client);
  });
  await invalidateSchemas();
  const schema = (await getSchema(tableName))!;
  await syncColumnIndexes(schema);
  return schema;
}

export async function addColumn(tableName: string, input: Record<string, unknown>) {
  const column = normalizeColumn(input);
  if (column.type === "relation" && !(await getSchema(column.ref!))) {
    throw new HttpError(400, `Linked table "${column.ref}" doesn't exist`);
  }
  let added: Column = column;
  const schema = await changeColumns(
    tableName,
    (columns) => {
      if (columns.some((c) => c.name === column.name)) {
        throw new HttpError(409, `A column named "${column.name}" already exists`);
      }
      added = column;
      return [...columns, column];
    },
    // existing records get numbers in the order they were created
    column.type === "autonumber" ? (client) => backfillAutonumber(tableName, column, client) : undefined
  );
  return { schema, column: added };
}

// A Text column can have at most this many different values to become a Choice.
export const MAX_CHOICE_CONVERSION = 50;

export async function updateColumn(tableName: string, columnName: string, payload: Record<string, unknown>) {
  let before: Column | undefined;
  let after: Column | undefined;
  let rewritten = 0;

  // Text -> Choice with no options given: use the values already in the column
  const existing = (await getSchema(tableName))?.columns.find((c) => c.name === columnName);
  if (existing && existing.type !== "choice" && payload.type === "choice" && !(Array.isArray(payload.options) && payload.options.length)) {
    const values = await distinctTextValues(tableName, columnName, MAX_CHOICE_CONVERSION + 1);
    if (values.length > MAX_CHOICE_CONVERSION) {
      throw new HttpError(
        400,
        `"${existing.label || existing.name}" has more than ${MAX_CHOICE_CONVERSION} different values, too many for a Choice`
      );
    }
    payload = { ...payload, options: values };
  }

  const schema = await changeColumns(
    tableName,
    (columns) => {
      const index = columns.findIndex((c) => c.name === columnName);
      if (index === -1) throw new HttpError(404, "Column not found");
      before = columns[index];
      after = applyColumnUpdate(columns[index], payload);
      return columns.map((c, i) => (i === index ? after! : c));
    },
    async (client) => {
      if (before!.type === "choice" || after!.type === "choice") {
        rewritten = await rewriteChoiceValues(tableName, before!, after!, client);
      }
    }
  );
  return { schema, before: before!, after: after!, rewritten };
}

export async function deleteColumn(tableName: string, columnName: string) {
  await assertNotUsedByRollups(tableName, columnName);
  let removed: Column | undefined;
  const schema = await changeColumns(
    tableName,
    (columns) => {
      removed = columns.find((c) => c.name === columnName);
      if (!removed) throw new HttpError(404, "Column not found");
      const usedBy = columns.filter((c) => c.type === "formula" && c.name !== columnName && formulaRefs(c).includes(columnName));
      if (usedBy.length) {
        throw new HttpError(
          400,
          `"${removed.label || removed.name}" is used by the formula ${usedBy.map((c) => `"${c.label || c.name}"`).join(", ")}. Change or delete that formula first.`
        );
      }
      return columns.filter((c) => c.name !== columnName);
    },
    (client) => deleteCounters(tableName, columnName, client)
  );
  return { schema, removed: removed! };
}

// settings: { showInMenu?, byDepartment?, departmentIds? }
export async function updateTableSettings(
  tableName: string,
  settings: { showInMenu?: unknown; byDepartment?: unknown; departmentIds?: string[] }
) {
  const flag = (v: unknown) => (typeof v === "boolean" ? v : null);
  const updated = await withTransaction(async (client) => {
    const { rowCount } = await query(
      `UPDATE table_schemas
       SET show_in_menu = COALESCE($2, show_in_menu), by_department = COALESCE($3, by_department), updated_at = now()
       WHERE table_name = $1`,
      [tableName, flag(settings.showInMenu), flag(settings.byDepartment)],
      client
    );
    if (!rowCount) return false;
    if (settings.departmentIds) {
      await query(`DELETE FROM table_departments WHERE table_name = $1`, [tableName], client);
      if (settings.departmentIds.length) {
        await query(
          `INSERT INTO table_departments (table_name, department_id)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [tableName, settings.departmentIds],
          client
        );
      }
    }
    return true;
  });
  if (!updated) throw new HttpError(404, "Table not found");
  await invalidateSchemas();
  return (await getSchema(tableName))!;
}

// Other tables with relation columns pointing at tableName.
export async function findRelationsTo(tableName: string) {
  return (await getAllSchemas()).flatMap((s) =>
    s.tableName === tableName
      ? []
      : s.columns.filter((c) => c.type === "relation" && c.ref === tableName).map((c) => ({ tableName: s.tableName, column: c.name }))
  );
}

// Drops the table, its schema, department links and role permissions.
// Returns the uploaded file URLs its records referenced.
export async function deleteTable(schema: TableSchema, fileColumns: string[]): Promise<string[]> {
  const urls = await withTransaction(async (client) => {
    const table = dataTable(schema.tableName);
    const exists = await query<{ t: string | null }>(`SELECT to_regclass($1) AS t`, [table], client);

    let found: string[] = [];
    if (exists.rows[0].t && fileColumns.length) {
      const { rows } = await query<{ files: unknown[] }>(
        `SELECT jsonb_build_array(${fileColumns.map((_, i) => `data -> $${i + 1}`).join(", ")}) AS files FROM ${table}`,
        fileColumns,
        client
      );
      found = rows.flatMap((r) => r.files.flat()).filter((u): u is string => typeof u === "string" && u.length > 0);
    }

    await query(`DROP TABLE IF EXISTS ${table}`, [], client);
    await query(`DELETE FROM table_schemas WHERE table_name = $1`, [schema.tableName], client);
    await removeTableFromRoles(schema.tableName, client);
    return found;
  });

  forgetDataTable(schema.tableName);
  await invalidateSchemas();
  return urls;
}

// Make sure every table has its storage and indexes (run at start-up).
export async function ensureAllDataTables() {
  for (const schema of await getAllSchemas()) {
    await ensureDataTable(schema.tableName);
    await syncColumnIndexes(schema).catch((err) =>
      logger.error({ err, table: schema.tableName }, "could not sync sort indexes")
    );
  }
}
