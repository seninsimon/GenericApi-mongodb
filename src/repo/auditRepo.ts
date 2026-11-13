import type { Request } from "express";
import { query, type Db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import type { CurrentUser, RecordData } from "../types.js";

// Audit log: who changed what, when.

export type AuditEntity = "record" | "session" | "user" | "role" | "department" | "table" | "column" | "app" | "email";

export interface AuditEvent {
  action: string;
  entity: AuditEntity;
  tableName?: string | null;
  recordId?: string | null;
  changes?: unknown;
  // overrides when there's no logged-in user (e.g. failed login)
  userId?: string | null;
  username?: string | null;
}

// Record an event for the request's user. Never throws: a failed audit write is
// logged, not surfaced (except inside a transaction, where `db` is given and the
// caller wants it to be part of the change).
export async function audit(req: Request | null, event: AuditEvent, db?: Db): Promise<void> {
  const user: CurrentUser | undefined = req?.user;
  const write = () =>
    query(
      `INSERT INTO audit_log (user_id, username, action, entity, table_name, record_id, changes, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        event.userId !== undefined ? event.userId : (user?._id ?? null),
        event.username !== undefined ? event.username : (user?.username ?? null),
        event.action,
        event.entity,
        event.tableName ?? null,
        event.recordId ?? null,
        event.changes === undefined ? null : JSON.stringify(event.changes),
        req?.ip ?? null,
      ],
      db
    );

  if (db) {
    await write();
    return;
  }
  await write().catch((err) => logger.error({ err, event }, "audit write failed"));
}

/* ---------------- record diffs ---------------- */

type Change = { from?: unknown; to?: unknown };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function diffRecord(before: RecordData, after: RecordData): Record<string, Change> {
  const changes: Record<string, Change> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!same(before[key], after[key])) changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
  }
  return changes;
}

export const snapshot = (data: RecordData, side: "from" | "to") =>
  Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => [k, { [side]: v }])
  );

/* ---------------- listing ---------------- */

export interface AuditFilter {
  tableName?: string;
  recordId?: string;
  userId?: string;
  action?: string;
  entity?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

export async function listAudit(filter: AuditFilter) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace("?", `$${params.length}`));
  };

  if (filter.tableName) add("table_name = ?", filter.tableName);
  if (filter.recordId) add("record_id = ?", filter.recordId);
  if (filter.userId) add("user_id = ?", filter.userId);
  if (filter.action) add("action = ?", filter.action);
  if (filter.entity) add("entity = ?", filter.entity);
  if (filter.from) add("at >= ?::timestamptz", filter.from);
  if (filter.to) add("at <= ?::timestamptz", filter.to);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const [{ rows }, { rows: count }] = await Promise.all([
    query(
      `SELECT _id::text, at, user_id, username, action, entity, table_name, record_id, changes, ip
       FROM audit_log ${where}
       ORDER BY at DESC, _id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, (filter.page - 1) * filter.limit]
    ),
    query<{ total: number }>(`SELECT count(*)::int AS total FROM audit_log ${where}`, params),
  ]);

  return {
    data: rows.map((r) => ({
      _id: r._id,
      at: r.at,
      userId: r.user_id,
      username: r.username,
      action: r.action,
      entity: r.entity,
      tableName: r.table_name,
      recordId: r.record_id,
      changes: r.changes,
      ip: r.ip,
    })),
    total: count[0].total,
    page: filter.page,
    limit: filter.limit,
  };
}
