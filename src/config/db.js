import pg from "pg";

const { Pool } = pg;

// Postgres limits identifiers to 63 bytes and silently truncates longer ones,
// which could make two different table names collide.
const MAX_IDENTIFIER_BYTES = 63;

export const SCHEMA_TABLE = "table_schemas";

export let pool;

export const query = (text, params) => pool.query(text, params);

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

// Each ERP table gets its own Postgres table. Rows are stored as JSONB so that
// columns can be added/removed/retyped from the UI without DDL migrations.
const ensuredTables = new Set();

export const ensureDataTable = async (tableName) => {
  if (ensuredTables.has(tableName)) return;
  if (tableName === SCHEMA_TABLE) {
    throw new Error(`"${SCHEMA_TABLE}" is a reserved table name`);
  }

  const table = quoteIdent(tableName);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      _id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      data        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  ensuredTables.add(tableName);
};

// 42P01 = undefined_table (a table that has never had data written to it)
export const isMissingTable = (error) => error?.code === "42P01";

const initSchema = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
      _id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      table_name    TEXT NOT NULL UNIQUE,
      columns       JSONB NOT NULL DEFAULT '[]'::jsonb,
      show_in_menu  BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
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
