import { query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";

// AI settings, set in the app (Administration → AI), kept in app_state under
// "ai". Keys are never sent back to the browser. Each provider keeps its own
// key, so switching back and forth doesn't mean pasting keys again.

export const PROVIDERS = ["anthropic", "gemini", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_NAMES: Record<Provider, string> = { anthropic: "Claude", gemini: "Gemini", openai: "ChatGPT" };

// Our pick per provider (checked on their model pages, 2026-11-13).
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-opus-5-5",
  gemini: "gemini-4-hydrogen",
  openai: "gpt-6.1-sol",
};

export type AiSettings = {
  provider: Provider;
  model: string; // empty: DEFAULT_MODELS[provider]
  keys: Partial<Record<Provider, string>>;
};

const DEFAULTS: AiSettings = { provider: "anthropic", model: "", keys: {} };

let cache: { at: number; value: AiSettings } | null = null;

export async function getAiSettings(): Promise<AiSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const { rows } = await query<{ value: Partial<AiSettings> }>(`SELECT value FROM app_state WHERE key = 'ai'`);
  const saved = rows[0]?.value ?? {};
  const value: AiSettings = { ...DEFAULTS, ...saved, keys: { ...(saved.keys ?? {}) } };
  cache = { at: Date.now(), value };
  return value;
}

// What drafting uses right now (null: not set up).
export async function activeAi(): Promise<{ provider: Provider; model: string; key: string } | null> {
  const s = await getAiSettings();
  const key = s.keys[s.provider];
  return key ? { provider: s.provider, model: s.model || DEFAULT_MODELS[s.provider], key } : null;
}

// What the admin's browser sees: which providers have a key, never the keys.
export const publicAiSettings = (s: AiSettings) => ({
  provider: s.provider,
  model: s.model,
  defaultModels: DEFAULT_MODELS,
  hasKey: Object.fromEntries(PROVIDERS.map((p) => [p, Boolean(s.keys[p])])) as Record<Provider, boolean>,
  ready: Boolean(s.keys[s.provider]),
});

// Check and save. An empty key keeps the saved one; removeKey forgets the
// chosen provider's key.
export async function saveAiSettings(input: Record<string, unknown>): Promise<AiSettings> {
  const current = await getAiSettings();
  const provider = PROVIDERS.includes(input.provider as Provider) ? (input.provider as Provider) : current.provider;
  const key = typeof input.key === "string" ? input.key.trim() : "";
  if (key && (key.length < 20 || key.length > 400 || /\s/.test(key))) {
    throw new HttpError(400, "That doesn't look like an API key", { key: "Paste the whole key, without spaces" });
  }
  const model = typeof input.model === "string" ? input.model.trim().slice(0, 100) : current.model;
  if (model && !/^[\w.:/-]+$/.test(model)) throw new HttpError(400, "Model names are letters, numbers, dots and dashes", { model: "e.g. " + DEFAULT_MODELS[provider] });

  const keys = { ...current.keys };
  if (input.removeKey === true) delete keys[provider];
  else if (key) keys[provider] = key;
  const next: AiSettings = {
    provider,
    // a model belongs to its provider: switching provider goes back to our pick
    model: provider === current.provider ? model : "",
    keys,
  };
  await query(
    `INSERT INTO app_state (key, value) VALUES ('ai', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(next)]
  );
  cache = null;
  return next;
}

// At start-up: an ANTHROPIC_API_KEY in .env fills Administration → AI once,
// while nothing is saved there. After that the app's settings count.
export async function importAiSettingsFromEnv() {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return false;
  const { rows } = await query(`SELECT 1 FROM app_state WHERE key = 'ai'`);
  if (rows.length) return false;
  await saveAiSettings({ provider: "anthropic", key });
  logger.info("the AI key was copied from .env into Administration → AI; ANTHROPIC_API_KEY in .env is no longer needed");
  return true;
}
