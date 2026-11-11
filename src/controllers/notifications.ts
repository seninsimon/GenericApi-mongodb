import type { Request, Response } from "express";
import { query } from "../db/pool.js";
import { HttpError, param } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import { actorNames, listAutomations, normalizeAutomation } from "../schema/automations.js";
import { getSchema } from "../schema/schemaRepo.js";

/* ---------------- the bell (every user, their own) ---------------- */

// GET /notifications: the latest 30, and how many are unread
export async function listNotificationsHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const { rows } = await query<{
    _id: string;
    title: string;
    body: string;
    table_name: string | null;
    record_id: string | null;
    actor: string | null;
    read_at: Date | null;
    created_at: Date;
  }>(`SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC, _id DESC LIMIT 30`, [user._id]);
  const { rows: count } = await query<{ n: string }>(
    `SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [user._id]
  );
  const name = await actorNames(rows.map((r) => r.actor ?? "").filter(Boolean));
  res.json({
    unread: Number(count[0].n),
    items: rows.map((r) => ({
      _id: String(r._id),
      title: r.title,
      body: r.body,
      tableName: r.table_name,
      recordId: r.record_id,
      actor: name(r.actor),
      read: Boolean(r.read_at),
      createdAt: r.created_at,
    })),
  });
}

// POST /notifications/read { ids? }: mark some (or all) as read
export async function readNotificationsHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).filter((id: string) => /^\d+$/.test(id)) : null;
  await query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL ${ids ? "AND _id = ANY($2::bigint[])" : ""}`,
    ids ? [user._id, ids] : [user._id]
  );
  res.json({ ok: true });
}

/* ---------------- automations (admins) ---------------- */

const tableOf = async (req: Request) => {
  const schema = await getSchema(param(req, "table"));
  if (!schema) throw new HttpError(404, "Table not found");
  return schema;
};

export async function listAutomationsHandler(req: Request, res: Response) {
  res.json(await listAutomations((await tableOf(req)).tableName));
}

export async function createAutomationHandler(req: Request, res: Response) {
  const schema = await tableOf(req);
  const a = normalizeAutomation(schema, req.body ?? {});
  const { rows } = await query(
    `INSERT INTO automations (table_name, name, trigger, actions, enabled) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5) RETURNING *`,
    [schema.tableName, a.name, JSON.stringify(a.trigger), JSON.stringify(a.actions), a.enabled]
  );
  await audit(req, { action: "create", entity: "table", tableName: schema.tableName, changes: { automation: a } });
  res.json(rows[0]);
}

export async function updateAutomationHandler(req: Request, res: Response) {
  const schema = await tableOf(req);
  const a = normalizeAutomation(schema, req.body ?? {});
  const { rows } = await query(
    `UPDATE automations SET name = $3, trigger = $4::jsonb, actions = $5::jsonb, enabled = $6, updated_at = now()
     WHERE _id = $1 AND table_name = $2 RETURNING *`,
    [param(req, "id"), schema.tableName, a.name, JSON.stringify(a.trigger), JSON.stringify(a.actions), a.enabled]
  );
  if (!rows[0]) throw new HttpError(404, "Automation not found");
  await audit(req, { action: "update", entity: "table", tableName: schema.tableName, changes: { automation: a } });
  res.json(rows[0]);
}

export async function deleteAutomationHandler(req: Request, res: Response) {
  const schema = await tableOf(req);
  const { rowCount } = await query(`DELETE FROM automations WHERE _id = $1 AND table_name = $2`, [param(req, "id"), schema.tableName]);
  if (!rowCount) throw new HttpError(404, "Automation not found");
  await audit(req, { action: "delete", entity: "table", tableName: schema.tableName, changes: { automation: param(req, "id") } });
  res.json({ ok: true });
}
