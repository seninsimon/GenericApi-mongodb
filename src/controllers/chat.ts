import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { isAdmin } from "../auth/access.js";
import { audienceOf, canRead, channelsFor, getChannel, readableChannel } from "../chat/channels.js";
import { excerpt, mentionedUsers } from "../chat/mentions.js";
import { getChatSettings, saveChatSettings } from "../chat/settings.js";
import { query, withTransaction } from "../db/pool.js";
import { HttpError, intParam, param } from "../lib/http.js";
import { emitChat } from "../live/events.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import { getUserById } from "../repo/userRepo.js";
import { notify } from "../schema/automations.js";

// Team chat (workspace/CHAT_PLAN.md). Messages go out live to the channel's
// people; @mentions also ring the bell (chat is never emailed).

const MAX_LENGTH = 4000;
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

async function chatOn() {
  const s = await getChatSettings();
  if (!s.teamChat) throw new HttpError(404, "Team chat is switched off");
  return s;
}

type MessageRow = {
  _id: string;
  channel_id: string;
  user_id: string | null;
  kind: string;
  body: string;
  attachments: { url: string; name: string }[];
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  name: string | null;
  reactions: { emoji: string; users: string[] }[] | null;
};

const shape = (r: MessageRow, me: string) => ({
  _id: r._id,
  channelId: r.channel_id,
  userId: r.user_id,
  name: r.name ?? "Deleted user",
  kind: r.kind,
  body: r.deleted_at ? "" : r.body,
  attachments: r.deleted_at ? [] : r.attachments,
  createdAt: r.created_at,
  editedAt: r.edited_at,
  deleted: Boolean(r.deleted_at),
  reactions: (r.reactions ?? []).map((x) => ({ emoji: x.emoji, count: x.users.length, mine: x.users.includes(me) })),
});

const MESSAGE_SELECT = `
  SELECT m._id, m.channel_id, m.user_id, m.kind, m.body, m.attachments, m.created_at, m.edited_at, m.deleted_at,
         COALESCE(NULLIF(u.full_name, ''), u.username) AS name,
         (SELECT jsonb_agg(jsonb_build_object('emoji', x.emoji, 'users', x.users) ORDER BY x.first)
          FROM (SELECT emoji, array_agg(user_id) AS users, min(ctid::text) AS first FROM chat_reactions WHERE message_id = m._id GROUP BY emoji) x) AS reactions
  FROM chat_messages m LEFT JOIN users u ON u._id = m.user_id`;

// GET /chat: switches, and this person's conversations with unread counts
export async function chatOverview(req: Request, res: Response) {
  const s = await getChatSettings();
  if (!s.teamChat) {
    res.json({ enabled: false, directMessages: s.directMessages, channels: [], unread: 0 });
    return;
  }
  const channels = await channelsFor(currentUser(req));
  res.json({
    enabled: true,
    directMessages: s.directMessages,
    channels,
    // the header's count: unread in your own conversations
    unread: channels.filter((c) => c.mine).reduce((n, c) => n + (c.kind === "everyone" || c.kind === "department" ? c.mentions : c.unread), 0),
  });
}

// GET /chat/:channel/messages?before=<id>&limit=50 (newest last)
export async function listMessages(req: Request, res: Response) {
  await chatOn();
  const user = currentUser(req);
  const channel = await readableChannel(user, param(req, "channel"));
  const before = typeof req.query.before === "string" && /^\d+$/.test(req.query.before) ? req.query.before : null;
  const limit = intParam(req.query.limit, 50, 1, 100);
  const { rows } = await query<MessageRow>(
    `${MESSAGE_SELECT} WHERE m.channel_id = $1 ${before ? "AND m._id < $3" : ""} ORDER BY m._id DESC LIMIT $2`,
    before ? [channel._id, limit, before] : [channel._id, limit]
  );
  res.json({ messages: rows.reverse().map((r) => shape(r, user._id)), more: rows.length === limit });
}

// POST /chat/:channel/messages { body, attachments? } or { call: true }
export async function postMessage(req: Request, res: Response) {
  await chatOn();
  const user = currentUser(req);
  const channel = await readableChannel(user, param(req, "channel"));
  const call = req.body?.call === true;
  const body = call ? `https://meet.jit.si/Zenin-${randomBytes(9).toString("base64url")}` : typeof req.body?.body === "string" ? req.body.body.trim() : "";
  const attachments = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
    .filter((a: unknown): a is { url: string; name?: string } => typeof (a as { url?: unknown })?.url === "string" && (a as { url: string }).url.startsWith("/uploads/"))
    .slice(0, 10)
    .map((a: { url: string; name?: string }) => ({ url: a.url, name: String(a.name ?? "file").slice(0, 200) }));
  if (!body && !attachments.length) throw new HttpError(400, "Write something first");
  if (body.length > MAX_LENGTH) throw new HttpError(400, `At most ${MAX_LENGTH} characters`);

  // mentions: only people who can read this conversation
  const mentioned: string[] = [];
  for (const id of call ? [] : await mentionedUsers(body)) {
    const person = id === user._id ? null : await getUserById(id);
    if (person && (await canRead(person, channel))) mentioned.push(id);
  }

  const message = await withTransaction(async (client) => {
    const { rows } = await query<{ _id: string }>(
      `INSERT INTO chat_messages (channel_id, user_id, kind, body, mentions, attachments) VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb) RETURNING _id`,
      [channel._id, user._id, call ? "call" : "text", body, mentioned, JSON.stringify(attachments)],
      client
    );
    await query(`UPDATE chat_channels SET last_message_at = now() WHERE _id = $1`, [channel._id], client);
    // what you send, you've read
    await query(
      `INSERT INTO chat_reads (channel_id, user_id, last_read_id) VALUES ($1, $2, $3)
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)`,
      [channel._id, user._id, rows[0]._id],
      client
    );
    const who = user.fullName || user.username;
    const where = channel.kind === "dm" ? "a message" : `#${channel.name}`;
    if (mentioned.length) {
      // "__chat" + the channel: the bell opens the conversation
      await notify(client, mentioned, { title: `${who} mentioned you in ${where}`, body: excerpt(body), tableName: "__chat", recordId: channel._id, actor: user._id }, { email: false });
    }
    await emitChat(channel._id, await audienceOf(channel, client), "message", user._id, rows[0]._id, client);
    return rows[0]._id;
  });
  res.status(201).json({ _id: message, ...(call ? { url: body } : {}) });
}

async function ownMessage(req: Request) {
  const user = currentUser(req);
  const { rows } = await query<{ _id: string; channel_id: string; user_id: string | null; deleted_at: Date | null }>(
    `SELECT _id, channel_id, user_id, deleted_at FROM chat_messages WHERE _id = $1`,
    [/^\d+$/.test(param(req, "message")) ? param(req, "message") : "0"]
  );
  const m = rows[0];
  const channel = m ? await getChannel(m.channel_id) : null;
  if (!m || !channel || m.deleted_at || !(await canRead(user, channel))) throw new HttpError(404, "Message not found");
  return { user, message: m, channel };
}

// PUT /chat/messages/:message { body } (its author)
export async function editMessage(req: Request, res: Response) {
  await chatOn();
  const { user, message, channel } = await ownMessage(req);
  if (message.user_id !== user._id) throw new HttpError(403, "Only its author can edit this message");
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body) throw new HttpError(400, "Write something first");
  if (body.length > MAX_LENGTH) throw new HttpError(400, `At most ${MAX_LENGTH} characters`);
  await query(`UPDATE chat_messages SET body = $2, edited_at = now() WHERE _id = $1`, [message._id, body]);
  await emitChat(channel._id, await audienceOf(channel), "update", user._id, message._id);
  res.json({ message: "Message updated" });
}

// DELETE /chat/messages/:message (its author; an admin, in open channels)
export async function deleteMessage(req: Request, res: Response) {
  await chatOn();
  const { user, message, channel } = await ownMessage(req);
  const moderator = isAdmin(user) && (channel.kind === "everyone" || channel.kind === "department");
  if (message.user_id !== user._id && !moderator) throw new HttpError(403, "Only its author can delete this message");
  await query(`UPDATE chat_messages SET deleted_at = now(), body = '', attachments = '[]'::jsonb WHERE _id = $1`, [message._id]);
  if (moderator && message.user_id !== user._id) {
    await audit(req, { action: "delete", entity: "chat", recordId: message._id, changes: { channel: channel.name } });
  }
  await emitChat(channel._id, await audienceOf(channel), "update", user._id, message._id);
  res.json({ message: "Message deleted" });
}

// POST /chat/messages/:message/reactions { emoji }: adds it, or takes yours back
export async function toggleReaction(req: Request, res: Response) {
  await chatOn();
  const { user, message, channel } = await ownMessage(req);
  const emoji = String(req.body?.emoji ?? "");
  if (!REACTIONS.includes(emoji)) throw new HttpError(400, "Choose one of the reactions");
  const removed = await query(`DELETE FROM chat_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`, [message._id, user._id, emoji]);
  if (!removed.rowCount) await query(`INSERT INTO chat_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [message._id, user._id, emoji]);
  await emitChat(channel._id, await audienceOf(channel), "update", user._id, message._id);
  res.json({ ok: true });
}

// POST /chat/:channel/read { lastId }
export async function markRead(req: Request, res: Response) {
  await chatOn();
  const user = currentUser(req);
  const channel = await readableChannel(user, param(req, "channel"));
  const lastId = /^\d+$/.test(String(req.body?.lastId ?? "")) ? String(req.body.lastId) : "0";
  await query(
    `INSERT INTO chat_reads (channel_id, user_id, last_read_id) VALUES ($1, $2, $3)
     ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_id = GREATEST(chat_reads.last_read_id, EXCLUDED.last_read_id)`,
    [channel._id, user._id, lastId]
  );
  // seen the conversation: its "mentioned you" notices are read too
  await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND table_name = '__chat' AND record_id = $2 AND read_at IS NULL`, [
    user._id,
    channel._id,
  ]);
  res.json({ ok: true });
}

// POST /chat/dm { userId }: the conversation with that person (made the first time)
export async function openDirect(req: Request, res: Response) {
  const settings = await chatOn();
  if (!settings.directMessages) throw new HttpError(403, "Direct messages are switched off");
  const user = currentUser(req);
  const other = await getUserById(String(req.body?.userId ?? ""));
  if (!other?.isActive) throw new HttpError(404, "Person not found");
  if (other._id === user._id) throw new HttpError(400, "Choose someone else");
  const key = [user._id, other._id].sort().join(":");
  const id = await withTransaction(async (client) => {
    const { rows } = await query<{ _id: string }>(
      `INSERT INTO chat_channels (kind, name, dm_key, created_by) VALUES ('dm', '', $1, $2)
       ON CONFLICT (dm_key) DO UPDATE SET dm_key = EXCLUDED.dm_key RETURNING _id`,
      [key, user._id],
      client
    );
    await query(`INSERT INTO chat_members (channel_id, user_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [rows[0]._id, [user._id, other._id]], client);
    return rows[0]._id;
  });
  res.json({ _id: id });
}

// POST /chat/groups { name, userIds }
export async function createGroup(req: Request, res: Response) {
  const settings = await chatOn();
  if (!settings.directMessages) throw new HttpError(403, "Private conversations are switched off");
  const user = currentUser(req);
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 60) : "";
  if (!name) throw new HttpError(400, "Give the group a name", { name: "Give the group a name" });
  const wanted = [...new Set((Array.isArray(req.body?.userIds) ? req.body.userIds : []).filter((x: unknown): x is string => typeof x === "string"))].slice(0, 200);
  const { rows: people } = await query<{ _id: string }>(`SELECT _id FROM users WHERE is_active AND _id = ANY($1::text[])`, [wanted]);
  if (!people.length) throw new HttpError(400, "Add at least one person", { userIds: "Add at least one person" });
  const id = await withTransaction(async (client) => {
    const { rows } = await query<{ _id: string }>(`INSERT INTO chat_channels (kind, name, created_by) VALUES ('group', $1, $2) RETURNING _id`, [name, user._id], client);
    await query(`INSERT INTO chat_members (channel_id, user_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [rows[0]._id, [user._id, ...people.map((p) => p._id)]], client);
    return rows[0]._id;
  });
  res.status(201).json({ _id: id });
}

// DELETE /chat/:channel/membership: leave a group
export async function leaveGroup(req: Request, res: Response) {
  await chatOn();
  const user = currentUser(req);
  const channel = await readableChannel(user, param(req, "channel"));
  if (channel.kind !== "group") throw new HttpError(400, "Only groups can be left");
  await query(`DELETE FROM chat_members WHERE channel_id = $1 AND user_id = $2`, [channel._id, user._id]);
  res.json({ message: "You left the group" });
}

// GET /chat/search?q=: messages in conversations you can read
export async function searchMessages(req: Request, res: Response) {
  await chatOn();
  const user = currentUser(req);
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  if (q.length < 2) {
    res.json([]);
    return;
  }
  const readable = (await channelsFor(user)).map((c) => c._id);
  const { rows } = await query<MessageRow & { channel_name: string }>(
    `${MESSAGE_SELECT.replace("FROM chat_messages m", "FROM chat_messages m")}
     WHERE m.channel_id = ANY($1::text[]) AND m.deleted_at IS NULL AND m.body ILIKE $2
     ORDER BY m._id DESC LIMIT 30`,
    [readable, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`]
  );
  res.json(rows.map((r) => shape(r, user._id)));
}

// Administration → Chat
export async function getChatSettingsHandler(_req: Request, res: Response) {
  res.json(await getChatSettings());
}
export async function saveChatSettingsHandler(req: Request, res: Response) {
  const saved = await saveChatSettings((req.body ?? {}) as Record<string, unknown>);
  await audit(req, { action: "settings", entity: "chat", changes: saved });
  res.json({ message: "Chat settings saved", settings: saved });
}
