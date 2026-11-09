import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { dbQueryDuration, slowQueries } from "../lib/metrics.js";

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: env.pgPoolMax,
});
pool.on("error", (err) => logger.error({ err }, "postgres pool error"));

// Anything that can run a query: the pool or a client inside a transaction.
export type Db = pg.Pool | PoolClient;

// Run a query, recording its duration and logging slow ones.
export async function query<R extends QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  db: Db = pool
): Promise<QueryResult<R>> {
  const start = performance.now();
  try {
    return await db.query<R>(text, params);
  } finally {
    const ms = performance.now() - start;
    dbQueryDuration.observe(ms / 1000);
    if (ms >= env.slowQueryMs) {
      slowQueries.inc();
      logger.warn({ ms: Math.round(ms), sql: text.replace(/\s+/g, " ").slice(0, 500) }, "slow query");
    }
  }
}

// Run fn(client) inside a transaction.
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
}

/* ---------------- identifiers & literals ---------------- */

// Postgres truncates identifiers longer than 63 bytes, which could make two
// different names collide.
const MAX_IDENTIFIER_BYTES = 63;

export const quoteIdent = (name: string): string => {
  if (typeof name !== "string" || !name.trim()) throw new Error("Name is required");
  if (Buffer.byteLength(name) > MAX_IDENTIFIER_BYTES) {
    throw new Error(`Name must be at most ${MAX_IDENTIFIER_BYTES} bytes`);
  }
  if (name.includes("\0")) throw new Error("Name contains invalid characters");
  return `"${name.replace(/"/g, '""')}"`;
};

// SQL string literal (standard_conforming_strings is on by default).
export const quoteLiteral = (value: string): string => {
  if (value.includes("\0")) throw new Error("Value contains invalid characters");
  return `'${value.replace(/'/g, "''")}'`;
};

/* ---------------- error codes ---------------- */

export const isMissingTable = (error: unknown) => (error as { code?: string })?.code === "42P01";
export const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === "23505";
