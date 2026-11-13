import type { Request, Response } from "express";
import { can, isAdmin, recordScope } from "../auth/access.js";
import { getChatSettings } from "../chat/settings.js";
import { excerpt, mentionedUsers } from "../chat/mentions.js";
import { query, withTransaction } from "../db/pool.js";
import { HttpError, param } from "../lib/http.js";
import { emitComment } from "../live/events.js";
import { currentUser } from "../middleware/auth.js";
import { getRecord } from "../repo/recordRepo.js";
import { getUserById } from "../repo/userRepo.js";
import { notify } from "../schema/automations.js";
import { pickDisplayField } from "../schema/columns.js";
import { getSchema } from "../schema/schemaRepo.js";
import type { CurrentUser, TableSchema } from "../types.js";

// Comments on a record: anyone who can see the record reads and writes them.
// The people @mentioned and the people already in the conversation are told
// (bell, live, and email by their choice); never the author.

const MAX_LENGTH = 4000;

async function loadRecord(req: Request) {
  const user = currentUser(req);
  if (!(await getChatSettings()).comments) throw new HttpError(404, "Comments are switched off");
  const schema = await getSchema(param(req, "collection"));
  if (!schema || !can(user, schema, "view")) throw new HttpError(404, "Table not found");
  const record = await getRecord(schema.tableName, param(req, "id"), recordScope(user, schema));
  if (!record) throw new HttpError(404, "Record not found");
  return { user, schema, record };
}

type Row = { _id: string; user_id: string | null; body: string; created_at: Date; edited_at: Date | null; full_name: string | null; username: string | null };
const shape = (r: Row) => ({
  _id: r._id,
  userId: r.user_id,
  name: r.full_name || r.username || "Deleted user",
  body: r.body,
  createdAt: r.created_at,
  editedAt: r.edited_at,
});

// GET /table/:collection/:id/comments
export async function listComments(req: Request, res: Response) {
  const { schema, record } = await loadRecord(req);
  const { rows } = await query<Row>(
    `SELECT c._id, c.user_id, c.body, c.created_at, c.edited_at, u.full_name, u.username
     FROM comments c LEFT JOIN users u ON u._id = c.user_id
     WHERE c.table_name = $1 AND c.record_id = $2 ORDER BY c._id LIMIT 500`,
    [schema.tableName, record._id]
  );
  res.json(rows.map(shape));
}

// can this person see this record? (mentions of people who can't aren't sent)
async function canSee(userId: string, schema: TableSchema, recordId: string) {
  const person = await getUserById(userId);
  if (!person?.isActive || !can(person, schema, "view")) return false;
  return Boolean(await getRecord(schema.tableName, recordId, recordScope(person, schema)));
}

const recordName = (schema: TableSchema, data: Record<string, unknown>) => {
  const field = pickDisplayField(schema);
  const v = field === "_id" ? "" : data[field];
  return v ? String(v) : schema.tableName.replace(/_/g, " ").replace(/s$/, "");
};

// POST /table/:collection/:id/comments { body }
export async function addComment(req: Request, res: Response) {
  const { user, schema, record } = await loadRecord(req);
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) throw new HttpError(400, "Write something first");
  if (body.length > MAX_LENGTH) throw new HttpError(400, `At most ${MAX_LENGTH} characters`);

  const mentioned = await mentionedUsers(body);
  const reachable: string[] = [];
  const unreachable: string[] = [];
  for (const id of mentioned.filter((id) => id !== user._id)) ((await canSee(id, schema, record._id)) ? reachable : unreachable).push(id);

  const comment = await withTransaction(async (client) => {
    const { rows } = await query<{ _id: string }>(
      `INSERT INTO comments (table_name, record_id, user_id, body, mentions) VALUES ($1, $2, $3, $4, $5::text[]) RETURNING _id`,
      [schema.tableName, record._id, user._id, body, mentioned],
      client
    );
    // the conversation so far (who can still see it), minus the mentioned and the author
    const { rows: earlier } = await query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM comments WHERE table_name = $1 AND record_id = $2 AND user_id IS NOT NULL AND _id <> $3`,
      [schema.tableName, record._id, rows[0]._id],
      client
    );
    const name = recordName(schema, record.data);
    const who = user.fullName || user.username;
    if (reachable.length) {
      await notify(client, reachable, { title: `${who} mentioned you on ${name}`, body: excerpt(body), tableName: schema.tableName, recordId: record._id, actor: user._id });
    }
    const followers: string[] = [];
    for (const r of earlier) if (r.user_id !== user._id && !reachable.includes(r.user_id) && (await canSee(r.user_id, schema, record._id))) followers.push(r.user_id);
    if (followers.length) {
      await notify(client, followers, { title: `${who} commented on ${name}`, body: excerpt(body), tableName: schema.tableName, recordId: record._id, actor: user._id });
    }
    await emitComment(schema.tableName, record._id, user._id, client);
    return rows[0]._id;
  });

  // say who wasn't told, by name
  const { rows: names } = unreachable.length
    ? await query<{ name: string }>(`SELECT COALESCE(NULLIF(full_name, ''), username) AS name FROM users WHERE _id = ANY($1::text[])`, [unreachable])
    : { rows: [] as { name: string }[] };
  res.status(201).json({
    _id: comment,
    warning: names.length ? `${names.map((n) => n.name).join(", ")} can't see this record, so ${names.length === 1 ? "wasn't" : "weren't"} told` : null,
  });
}

async function ownComment(req: Request, user: CurrentUser, allowAdmin: boolean) {
  const { schema, record } = await loadRecord(req);
  const { rows } = await query<{ _id: string; user_id: string | null }>(
    `SELECT _id, user_id FROM comments WHERE _id = $1 AND table_name = $2 AND record_id = $3`,
    [param(req, "commentId"), schema.tableName, record._id]
  );
  const c = rows[0];
  if (!c) throw new HttpError(404, "Comment not found");
  if (c.user_id !== user._id && !(allowAdmin && isAdmin(user))) throw new HttpError(403, "Only its author can change this comment");
  return { schema, record, comment: c };
}

// PUT /table/:collection/:id/comments/:commentId { body }
export async function editComment(req: Request, res: Response) {
  const user = currentUser(req);
  const { schema, record, comment } = await ownComment(req, user, false);
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) throw new HttpError(400, "Write something first");
  if (body.length > MAX_LENGTH) throw new HttpError(400, `At most ${MAX_LENGTH} characters`);
  await query(`UPDATE comments SET body = $2, mentions = $3::text[], edited_at = now() WHERE _id = $1`, [comment._id, body, await mentionedUsers(body)]);
  await emitComment(schema.tableName, record._id, user._id);
  res.json({ message: "Comment updated" });
}

// DELETE /table/:collection/:id/comments/:commentId (its author, or an admin)
export async function deleteComment(req: Request, res: Response) {
  const user = currentUser(req);
  const { schema, record, comment } = await ownComment(req, user, true);
  await query(`DELETE FROM comments WHERE _id = $1`, [comment._id]);
  await emitComment(schema.tableName, record._id, user._id);
  res.json({ message: "Comment deleted" });
}
