import { query } from "../db/pool.js";

// Administration → Chat: three switches, kept in app_state under "chat".
export type ChatSettings = {
  teamChat: boolean; // channels, direct messages, groups
  directMessages: boolean; // people may message each other privately
  comments: boolean; // comments on records
};
const DEFAULTS: ChatSettings = { teamChat: false, directMessages: true, comments: true };

let cache: { at: number; value: ChatSettings } | null = null;

export async function getChatSettings(): Promise<ChatSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const { rows } = await query<{ value: Partial<ChatSettings> }>(`SELECT value FROM app_state WHERE key = 'chat'`);
  cache = { at: Date.now(), value: { ...DEFAULTS, ...(rows[0]?.value ?? {}) } };
  return cache.value;
}

export async function saveChatSettings(input: Record<string, unknown>): Promise<ChatSettings> {
  const current = await getChatSettings();
  const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const next: ChatSettings = {
    teamChat: flag(input.teamChat, current.teamChat),
    directMessages: flag(input.directMessages, current.directMessages),
    comments: flag(input.comments, current.comments),
  };
  await query(
    `INSERT INTO app_state (key, value) VALUES ('chat', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(next)]
  );
  cache = null;
  return next;
}
