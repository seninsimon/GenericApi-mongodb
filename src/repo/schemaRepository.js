import { ensureDataTable, pool, query, SCHEMA_TABLE } from "../config/db.js";
import {
  applyColumnUpdate,
  normalizeColumn,
  normalizeTableSchema,
  toTableSchema,
  ValidationError,
} from "../models/TableSchema.js";

const updateResult = (rowCount) => ({
  acknowledged: true,
  matchedCount: rowCount,
  modifiedCount: rowCount,
});

export const createTableSchema = async (data) => {
  const schema = normalizeTableSchema(data);

  if (schema.tableName === SCHEMA_TABLE) {
    throw new ValidationError(`"${SCHEMA_TABLE}" is a reserved table name`);
  }

  await ensureDataTable(schema.tableName);

  const { rows } = await query(
    `INSERT INTO ${SCHEMA_TABLE} (table_name, columns, show_in_menu)
     VALUES ($1, $2::jsonb, $3)
     RETURNING *`,
    [schema.tableName, JSON.stringify(schema.columns), schema.showInMenu]
  );
  return toTableSchema(rows[0]);
};

export const getAllSchemas = async () => {
  const { rows } = await query(
    `SELECT * FROM ${SCHEMA_TABLE} ORDER BY created_at, _id`
  );
  return rows.map(toTableSchema);
};

export const getSchemaByName = async (tableName) => {
  const { rows } = await query(
    `SELECT * FROM ${SCHEMA_TABLE} WHERE table_name = $1`,
    [tableName]
  );
  return toTableSchema(rows[0]) ?? null;
};

export const addColumn = async (tableName, column) => {
  const normalized = normalizeColumn(column);
  const { rowCount } = await query(
    `UPDATE ${SCHEMA_TABLE}
     SET columns = columns || $2::jsonb, updated_at = now()
     WHERE table_name = $1`,
    [tableName, JSON.stringify([normalized])]
  );
  return updateResult(rowCount);
};

export const deleteColumn = async (tableName, columnName) => {
  const { rowCount } = await query(
    `UPDATE ${SCHEMA_TABLE}
     SET columns = COALESCE(
           (SELECT jsonb_agg(c ORDER BY ord)
            FROM jsonb_array_elements(columns) WITH ORDINALITY AS t(c, ord)
            WHERE c->>'name' IS DISTINCT FROM $2),
           '[]'::jsonb),
         updated_at = now()
     WHERE table_name = $1
       AND columns @> jsonb_build_array(jsonb_build_object('name', $2::text))`,
    [tableName, columnName]
  );
  return updateResult(rowCount);
};

export const updateColumnInSchema = async (tableName, columnName, payload) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT columns FROM ${SCHEMA_TABLE} WHERE table_name = $1 FOR UPDATE`,
      [tableName]
    );
    const columns = rows[0]?.columns ?? [];
    const index = columns.findIndex((c) => c.name === columnName);

    if (index === -1) {
      await client.query("ROLLBACK");
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }

    columns[index] = applyColumnUpdate(columns[index], payload);

    await client.query(
      `UPDATE ${SCHEMA_TABLE}
       SET columns = $2::jsonb, updated_at = now()
       WHERE table_name = $1`,
      [tableName, JSON.stringify(columns)]
    );
    await client.query("COMMIT");
    return updateResult(1);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

export const updateTableSettings = async (tableName, showInMenu) => {
  const { rows } = await query(
    `UPDATE ${SCHEMA_TABLE}
     SET show_in_menu = COALESCE($2, show_in_menu), updated_at = now()
     WHERE table_name = $1
     RETURNING *`,
    [tableName, typeof showInMenu === "boolean" ? showInMenu : null]
  );
  return toTableSchema(rows[0]) ?? null;
};
