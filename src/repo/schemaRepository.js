import {
  DATA_SCHEMA,
  dataTable,
  ensureDataTable,
  forgetDataTable,
  pool,
  query,
  quoteIdent,
  SCHEMA_TABLE,
  withTransaction,
} from "../config/db.js";
import {
  applyColumnUpdate,
  normalizeColumn,
  normalizeTableSchema,
  toTableSchema,
} from "../models/TableSchema.js";

// table schema + its departments ([{ _id, name }])
const SCHEMA_SELECT = `
  SELECT s.*,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('_id', d._id, 'name', d.name) ORDER BY d.name)
      FROM table_departments td JOIN departments d ON d._id = td.department_id
      WHERE td.table_name = s.table_name
    ), '[]'::jsonb) AS departments
  FROM ${SCHEMA_TABLE} s
`;

const updateResult = (rowCount) => ({
  acknowledged: true,
  matchedCount: rowCount,
  modifiedCount: rowCount,
});

export const createTableSchema = async (data) => {
  const schema = normalizeTableSchema(data);

  await ensureDataTable(schema.tableName);

  await query(
    `INSERT INTO ${SCHEMA_TABLE} (table_name, columns, show_in_menu)
     VALUES ($1, $2::jsonb, $3)`,
    [schema.tableName, JSON.stringify(schema.columns), schema.showInMenu]
  );
  return getSchemaByName(schema.tableName);
};

export const getAllSchemas = async () => {
  const { rows } = await query(`${SCHEMA_SELECT} ORDER BY s.created_at, s._id`);
  return rows.map(toTableSchema);
};

export const getSchemaByName = async (tableName) => {
  const { rows } = await query(`${SCHEMA_SELECT} WHERE s.table_name = $1`, [tableName]);
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

// Other tables with relation columns pointing at tableName: [{ tableName, column }]
export const findRelationsTo = async (tableName) => {
  const { rows } = await query(
    `SELECT s.table_name, c->>'name' AS column_name
     FROM ${SCHEMA_TABLE} s, jsonb_array_elements(s.columns) c
     WHERE c->>'type' = 'relation' AND c->>'ref' = $1 AND s.table_name <> $1`,
    [tableName]
  );
  return rows.map((r) => ({ tableName: r.table_name, column: r.column_name }));
};

// Drops the table, its schema, department links and role permissions for it.
// Returns the uploaded file URLs that were referenced by its records.
export const deleteTableSchema = async (tableName, fileColumnNames) => {
  const fileUrls = await withTransaction(async (client) => {
    const table = dataTable(tableName);
    const exists = await client.query(`SELECT to_regclass($1) AS t`, [
      `${DATA_SCHEMA}.${quoteIdent(tableName)}`,
    ]);

    // collect file references before the rows are gone
    let urls = [];
    if (exists.rows[0].t && fileColumnNames.length) {
      const { rows } = await client.query(
        `SELECT jsonb_build_array(${fileColumnNames.map((_, i) => `data -> $${i + 1}`).join(", ")}) AS files
         FROM ${table}`,
        fileColumnNames
      );
      urls = rows.flatMap((r) => r.files.flat()).filter((u) => typeof u === "string" && u);
    }

    await client.query(`DROP TABLE IF EXISTS ${table}`);
    await client.query(`DELETE FROM ${SCHEMA_TABLE} WHERE table_name = $1`, [tableName]);
    await client.query(`UPDATE roles SET permissions = permissions - $1::text`, [tableName]);
    return urls;
  });

  forgetDataTable(tableName);
  return fileUrls;
};

// settings: { showInMenu?: boolean, departmentIds?: string[] }
export const updateTableSettings = async (tableName, { showInMenu, departmentIds }) => {
  const updated = await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE ${SCHEMA_TABLE}
       SET show_in_menu = COALESCE($2, show_in_menu), updated_at = now()
       WHERE table_name = $1`,
      [tableName, typeof showInMenu === "boolean" ? showInMenu : null]
    );
    if (!rowCount) return false;

    if (Array.isArray(departmentIds)) {
      await client.query(`DELETE FROM table_departments WHERE table_name = $1`, [tableName]);
      if (departmentIds.length) {
        await client.query(
          `INSERT INTO table_departments (table_name, department_id)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [tableName, departmentIds]
        );
      }
    }
    return true;
  });

  return updated ? getSchemaByName(tableName) : null;
};
