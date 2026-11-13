import { isAdmin } from "../auth/access.js";
import { query, type Db } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import type { ChatAudience } from "../live/events.js";
import type { CurrentUser } from "../types.js";

// Channels:
//   everyone    one, for all
//   department  one per department; its members are the department's people
//               (admins can read them too: they're the organization's open channels)
//   group       a name and chosen people
//   dm          two people
// Groups and direct messages are private to their members, admins included.

export type Channel = { _id: string; kind: string; name: string; department_id: string | null; created_by: string | null };

// The automatic channels exist, and department channels follow renames.
export async function ensureChannels(db?: Db) {
  await query(`INSERT INTO chat_channels (kind, name) VALUES ('everyone', 'everyone') ON CONFLICT DO NOTHING`, [], db);
  await query(
    `INSERT INTO chat_channels (kind, name, department_id)
     SELECT 'department', d.name, d._id FROM departments d
     WHERE NOT EXISTS (SELECT 1 FROM chat_channels c WHERE c.kind = 'department' AND c.department_id = d._id)`,
    [],
    db
  );
  await query(
    `UPDATE chat_channels c SET name = d.name FROM departments d WHERE c.kind = 'department' AND c.department_id = d._id AND c.name <> d.name`,
    [],
    db
  );
}

export async function getChannel(id: string, db?: Db): Promise<Channel | null> {
  const { rows } = await query<Channel>(`SELECT _id, kind, name, department_id, created_by FROM chat_channels WHERE _id = $1`, [id], db);
  return rows[0] ?? null;
}

const members = async (channelId: string, db?: Db) =>
  (await query<{ user_id: string }>(`SELECT user_id FROM chat_members WHERE channel_id = $1`, [channelId], db)).rows.map((r) => r.user_id);

// Who may read it (for live events).
export async function audienceOf(channel: Channel, db?: Db): Promise<ChatAudience> {
  return {
    kind: channel.kind,
    departmentId: channel.department_id,
    members: channel.kind === "group" || channel.kind === "dm" ? await members(channel._id, db) : [],
  };
}

export async function canRead(user: CurrentUser, channel: Channel, db?: Db) {
  if (channel.kind === "everyone") return true;
  if (channel.kind === "department") return isAdmin(user) || user.departments.some((d) => d._id === channel.department_id);
  return (await members(channel._id, db)).includes(user._id);
}

// The channel, if this person may read it (else "not found").
export async function readableChannel(user: CurrentUser, id: string, db?: Db) {
  const channel = await getChannel(id, db);
  if (!channel || !(await canRead(user, channel, db))) throw new HttpError(404, "Conversation not found");
  return channel;
}

// Everything this person sees in the chat list, with unread counts.
export async function channelsFor(user: CurrentUser) {
  await ensureChannels();
  const departmentIds = user.departments.map((d) => d._id);
  const { rows } = await query<{
    _id: string;
    kind: string;
    name: string;
    department_id: string | null;
    last_message_at: Date | null;
    unread: number;
    mentions: number;
    other_id: string | null;
    other_name: string | null;
    other_active: boolean | null;
    member_count: number;
  }>(
    `SELECT c._id, c.kind, c.name, c.department_id, c.last_message_at,
       (SELECT count(*)::int FROM chat_messages m
         WHERE m.channel_id = c._id AND m.deleted_at IS NULL AND m.user_id IS DISTINCT FROM $1
           AND m._id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.channel_id = c._id AND r.user_id = $1), 0)) AS unread,
       (SELECT count(*)::int FROM chat_messages m
         WHERE m.channel_id = c._id AND m.deleted_at IS NULL AND m.mentions @> ARRAY[$1]::text[]
           AND m._id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.channel_id = c._id AND r.user_id = $1), 0)) AS mentions,
       o._id AS other_id, COALESCE(NULLIF(o.full_name, ''), o.username) AS other_name, o.is_active AS other_active,
       (SELECT count(*)::int FROM chat_members cm WHERE cm.channel_id = c._id) AS member_count
     FROM chat_channels c
     LEFT JOIN LATERAL (
       SELECT u.* FROM chat_members cm JOIN users u ON u._id = cm.user_id
       WHERE c.kind = 'dm' AND cm.channel_id = c._id AND cm.user_id <> $1 LIMIT 1
     ) o ON true
     WHERE c.kind = 'everyone'
        OR (c.kind = 'department' AND ($3 OR c.department_id = ANY($2::text[])))
        OR (c.kind IN ('group', 'dm') AND EXISTS (SELECT 1 FROM chat_members cm WHERE cm.channel_id = c._id AND cm.user_id = $1))
     ORDER BY CASE c.kind WHEN 'everyone' THEN 0 WHEN 'department' THEN 1 WHEN 'group' THEN 2 ELSE 3 END,
              c.last_message_at DESC NULLS LAST, c.name`,
    [user._id, departmentIds, isAdmin(user)]
  );
  return rows.map((r) => ({
    _id: r._id,
    kind: r.kind,
    name: r.kind === "dm" ? (r.other_name ?? "Deleted user") : r.name,
    otherUserId: r.other_id,
    otherActive: r.other_active,
    // admins see every department channel; "yours" are the ones you're in
    mine: r.kind !== "department" || departmentIds.includes(r.department_id ?? ""),
    memberCount: r.member_count,
    lastMessageAt: r.last_message_at,
    unread: r.unread,
    mentions: r.mentions,
  }));
}
