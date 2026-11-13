import { query, type Db } from "../db/pool.js";

// "@sam can you…": mentions are usernames after an @ (the composer suggests
// them as you type). Returns the active people mentioned, by id.
export async function mentionedUsers(body: string, db?: Db): Promise<string[]> {
  const names = [...new Set([...body.matchAll(/(^|[^\w.@])@([A-Za-z0-9._-]{3,50})/g)].map((m) => m[2].replace(/[.]+$/, "").toLowerCase()))];
  if (!names.length) return [];
  const { rows } = await query<{ _id: string }>(`SELECT _id FROM users WHERE is_active AND lower(username) = ANY($1::text[])`, [names], db);
  return rows.map((r) => r._id);
}

// A short preview for notifications.
export const excerpt = (body: string, max = 140) => {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
