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

// The AI features an admin switches on and off. A switch appears once its
// feature exists. workspace/AI_FEATURES_PLAN.md
export const FEATURES = ["draftApps", "askZenin"] as const;
export type Feature = (typeof FEATURES)[number];
const FEATURE_DEFAULTS: Record<Feature, boolean> = { draftApps: true, askZenin: false };

export type AiLimits = {
  monthlyUsd: number | null; // pause AI features at this estimated spend a month
  perPersonDaily: number | null; // requests a person may make a day (admins aren't limited)
};

export type AiSettings = {
  provider: Provider;
  model: string; // empty: DEFAULT_MODELS[provider]
  keys: Partial<Record<Provider, string>>;
  features: Record<Feature, boolean>;
  limits: AiLimits;
  askRoles: string[]; // who may use Ask Zenin: these roles (ids); empty = everyone
};

const NO_LIMITS: AiLimits = { monthlyUsd: null, perPersonDaily: null };

let cache: { at: number; value: AiSettings } | null = null;

export async function getAiSettings(): Promise<AiSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const { rows } = await query<{ value: Partial<AiSettings> }>(`SELECT value FROM app_state WHERE key = 'ai'`);
  const saved = rows[0]?.value ?? {};
  const value: AiSettings = {
    provider: saved.provider ?? "anthropic",
    model: saved.model ?? "",
    keys: { ...(saved.keys ?? {}) },
    features: { ...FEATURE_DEFAULTS, ...(saved.features ?? {}) },
    limits: { ...NO_LIMITS, ...(saved.limits ?? {}) },
    askRoles: Array.isArray(saved.askRoles) ? saved.askRoles : [],
  };
  cache = { at: Date.now(), value };
  return value;
}

// The AI in use right now (null: no key, so every AI feature is off).
export async function activeAi(): Promise<{ provider: Provider; model: string; key: string } | null> {
  const s = await getAiSettings();
  const key = s.keys[s.provider];
  return key ? { provider: s.provider, model: s.model || DEFAULT_MODELS[s.provider], key } : null;
}

// A feature is usable when there's a key and its switch is on.
export async function featureOn(feature: Feature) {
  const s = await getAiSettings();
  return Boolean(s.keys[s.provider]) && s.features[feature];
}

// What the admin's browser sees: which providers have a key, never the keys.
export const publicAiSettings = (s: AiSettings) => ({
  provider: s.provider,
  model: s.model,
  defaultModels: DEFAULT_MODELS,
  hasKey: Object.fromEntries(PROVIDERS.map((p) => [p, Boolean(s.keys[p])])) as Record<Provider, boolean>,
  ready: Boolean(s.keys[s.provider]),
  features: s.features,
  limits: s.limits,
  askRoles: s.askRoles,
});

// A limit from the form: empty or 0 means no limit.
const limitValue = (v: unknown, max: number, field: string, label: string) => {
  if (v === null || v === undefined || v === "" || v === 0) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${label} must be between 0 and ${max}`, { [field]: `0 to ${max}` });
  return n;
};

// Check and save. Only what's sent changes: an empty key keeps the saved one,
// removeKey forgets the chosen provider's key.
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

  const features = { ...current.features };
  if (input.features && typeof input.features === "object") {
    for (const f of FEATURES) {
      const v = (input.features as Record<string, unknown>)[f];
      if (typeof v === "boolean") features[f] = v;
    }
  }

  const limits = { ...current.limits };
  if (input.limits && typeof input.limits === "object") {
    const l = input.limits as Record<string, unknown>;
    if ("monthlyUsd" in l) limits.monthlyUsd = limitValue(l.monthlyUsd, 100_000, "monthlyUsd", "The monthly limit");
    if ("perPersonDaily" in l) {
      const n = limitValue(l.perPersonDaily, 10_000, "perPersonDaily", "The daily limit");
      limits.perPersonDaily = n === null ? null : Math.max(1, Math.round(n));
    }
  }

  let askRoles = current.askRoles;
  if (input.askRoles !== undefined) {
    if (!Array.isArray(input.askRoles) || input.askRoles.length > 100 || !input.askRoles.every((r) => typeof r === "string")) {
      throw new HttpError(400, "Choose roles from the list", { askRoles: "Choose roles from the list" });
    }
    askRoles = [...new Set(input.askRoles as string[])];
  }

  const next: AiSettings = {
    provider,
    // a model belongs to its provider: switching provider goes back to our pick
    model: provider === current.provider ? model : "",
    keys,
    features,
    limits,
    askRoles,
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
