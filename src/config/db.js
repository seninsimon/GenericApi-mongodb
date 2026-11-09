import pg from "pg";
import { createHash } from "crypto";

const { Pool } = pg;

// Postgres limits identifiers to 63 bytes and silently truncates longer ones,
// which could make two different table names collide.
const MAX_IDENTIFIER_BYTES = 63;

export const SCHEMA_TABLE = "table_schemas";

// User-defined ERP tables live in their own Postgres schema so they can never
// clash with system tables (users, roles, departments, ...) in "public".
export const DATA_SCHEMA = "erp_data";

export let pool;

export const query = (text, params) => pool.query(text, params);

// Run fn(client) inside a transaction.
export const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

// Quote a user-supplied table name so it can be safely used as an identifier.
export const quoteIdent = (name) => {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("Table name is required");
  }
  if (Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new Error(`Table name must be at most ${MAX_IDENTIFIER_BYTES} bytes`);
  }
  if (name.includes("\0")) {
    throw new Error("Table name contains invalid characters");
  }
  return `"${name.replace(/"/g, '""')}"`;
};

// Fully qualified, quoted name of an ERP data table.
export const dataTable = (name) => `${DATA_SCHEMA}.${quoteIdent(name)}`;

// Each ERP table gets its own Postgres table. Rows are stored as JSONB so that
// columns can be added/removed/retyped from the UI without DDL migrations.
// department_id says which department a record belongs to.
const ensuredTables = new Set();

export const ensureDataTable = async (tableName) => {
  if (ensuredTables.has(tableName)) return;

  const table = dataTable(tableName);
  const indexName = quoteIdent(
    `${createHash("sha1").update(tableName).digest("hex").slice(0, 20)}_department_idx`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      _id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      data           JSONB NOT NULL DEFAULT '{}'::jsonb,
      department_id  TEXT REFERENCES departments(_id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // tables created before departments existed
  await pool.query(`
    ALTER TABLE ${table}
    ADD COLUMN IF NOT EXISTS department_id TEXT REFERENCES departments(_id) ON DELETE SET NULL
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (department_id)`);

  ensuredTables.add(tableName);
};

// After a table is dropped, so a new table with the same name gets created again.
export const forgetDataTable = (tableName) => ensuredTables.delete(tableName);

// 42P01 = undefined_table (a table that has never had data written to it)
export const isMissingTable = (error) => error?.code === "42P01";

// 23505 = unique_violation
export const isUniqueViolation = (error) => error?.code === "23505";

const timestamps = `
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
`;

const initSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
      _id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      table_name    TEXT NOT NULL UNIQUE,
      columns       JSONB NOT NULL DEFAULT '[]'::jsonb,
      show_in_menu  BOOLEAN NOT NULL DEFAULT TRUE,
      ${timestamps}
    )
  `);

  // Move data tables created before DATA_SCHEMA existed out of "public".
  // This must run before the system tables below are created, in case a user
  // table is named e.g. "users".
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${DATA_SCHEMA}`);
  const { rows: legacy } = await pool.query(
    `SELECT s.table_name
     FROM ${SCHEMA_TABLE} s
     WHERE to_regclass(format('public.%I', s.table_name)) IS NOT NULL
       AND to_regclass(format('${DATA_SCHEMA}.%I', s.table_name)) IS NULL`
  );
  for (const { table_name } of legacy) {
    await pool.query(`ALTER TABLE public.${quoteIdent(table_name)} SET SCHEMA ${DATA_SCHEMA}`);
    console.log(`Moved data table "${table_name}" to schema ${DATA_SCHEMA}`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      _id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      ${timestamps}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS departments_name_key ON departments (lower(name));

    -- permissions: { "<tableName>": { "view": bool, "create": bool, "edit": bool, "delete": bool } }
    CREATE TABLE IF NOT EXISTS roles (
      _id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      is_admin     BOOLEAN NOT NULL DEFAULT FALSE,
      permissions  JSONB NOT NULL DEFAULT '{}'::jsonb,
      ${timestamps}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS roles_name_key ON roles (lower(name));

    CREATE TABLE IF NOT EXISTS users (
      _id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      username       TEXT NOT NULL,
      full_name      TEXT NOT NULL DEFAULT '',
      email          TEXT NOT NULL DEFAULT '',
      phone          TEXT NOT NULL DEFAULT '',
      password_hash  TEXT NOT NULL,
      role_id        TEXT NOT NULL REFERENCES roles(_id) ON DELETE RESTRICT,
      is_active      BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at  TIMESTAMPTZ,
      ${timestamps}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));

    CREATE TABLE IF NOT EXISTS user_departments (
      user_id        TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
      department_id  TEXT NOT NULL REFERENCES departments(_id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, department_id)
    );

    CREATE TABLE IF NOT EXISTS table_departments (
      table_name     TEXT NOT NULL REFERENCES ${SCHEMA_TABLE}(table_name) ON DELETE CASCADE,
      department_id  TEXT NOT NULL REFERENCES departments(_id) ON DELETE CASCADE,
      PRIMARY KEY (table_name, department_id)
    );

    -- token_hash = sha256 of the session cookie value
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
  `);

  // built-in Admin role (full access, can open Settings)
  await pool.query(`
    INSERT INTO roles (name, description, is_admin)
    SELECT 'Admin', 'Full access to all tables and settings', TRUE
    WHERE NOT EXISTS (SELECT 1 FROM roles WHERE is_admin)
  `);

  // make sure every existing data table has the department column
  const { rows: tables } = await pool.query(`SELECT table_name FROM ${SCHEMA_TABLE}`);
  for (const { table_name } of tables) {
    await ensureDataTable(table_name);
  }
};

const connectDB = async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  try {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => console.error("Postgres pool error:", err));
    await pool.query("SELECT 1");
    await initSchema();
    console.log("Postgres Connected");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

export default connectDB;
