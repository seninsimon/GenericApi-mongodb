import { query } from "../db/pool.js";
import { HttpError, isValidEmail } from "../lib/http.js";

// Email settings, set in the app (Administration → Email), kept in app_state
// under "mail". The password is never sent back to the browser.

export type MailSettings = {
  enabled: boolean;
  provider: "gmail" | "smtp";
  host: string;
  port: number;
  user: string; // the login, for Gmail the address
  pass: string;
  fromName: string; // "Zenin ERP"
  fromAddress: string; // for Gmail, the same address
  appUrl: string; // where "Open in Zenin ERP" links go
  timeZone: string;
  summaryHour: number; // the morning summary, 0-23
};

export const DEFAULTS: MailSettings = {
  enabled: false,
  provider: "gmail",
  host: "smtp.gmail.com",
  port: 587,
  user: "",
  pass: "",
  fromName: "Zenin ERP",
  fromAddress: "",
  appUrl: "",
  timeZone: "Asia/Kolkata",
  summaryHour: 8,
};

let cache: { at: number; value: MailSettings } | null = null;
const TTL_MS = 30_000; // the worker (another process) picks up changes within this

export async function getMailSettings(): Promise<MailSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const { rows } = await query<{ value: Partial<MailSettings> }>(`SELECT value FROM app_state WHERE key = 'mail'`);
  const value = { ...DEFAULTS, ...(rows[0]?.value ?? {}) };
  cache = { at: Date.now(), value };
  return value;
}

export const forgetMailSettings = () => {
  cache = null;
};

// What the admin's browser sees: everything but the password.
export const publicSettings = (s: MailSettings) => {
  const { pass, ...rest } = s;
  return { ...rest, hasPassword: Boolean(pass) };
};

const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// Check and save what the admin sent. An empty password keeps the saved one.
export async function saveMailSettings(input: Record<string, unknown>): Promise<MailSettings> {
  const current = await getMailSettings();
  const text = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const provider = input.provider === "smtp" ? "smtp" : "gmail";
  const user = text(input.user);
  const next: MailSettings = {
    enabled: input.enabled !== false,
    provider,
    host: provider === "gmail" ? "smtp.gmail.com" : text(input.host),
    port: provider === "gmail" ? 587 : Number(input.port) || 587,
    user,
    // Google shows app passwords in groups of four
    pass: text(input.pass, 300).replace(/\s+/g, "") || current.pass,
    fromName: text(input.fromName, 100) || "Zenin ERP",
    fromAddress: provider === "gmail" ? user : text(input.fromAddress),
    appUrl: text(input.appUrl, 300).replace(/\/+$/, ""),
    timeZone: text(input.timeZone, 60) || "Asia/Kolkata",
    summaryHour: Math.min(23, Math.max(0, Math.round(Number(input.summaryHour ?? 8)))),
  };
  if (next.enabled) {
    if (!next.host) throw new HttpError(400, "Enter the mail server (host)", { host: "Enter the mail server" });
    if (!isValidEmail(next.user) && next.provider === "gmail") throw new HttpError(400, "Enter the Gmail address", { user: "Enter the Gmail address" });
    if (!next.user) throw new HttpError(400, "Enter the login", { user: "Enter the login" });
    if (!next.pass) throw new HttpError(400, "Enter the app password", { pass: "Enter the app password" });
    if (!isValidEmail(next.fromAddress)) throw new HttpError(400, "Enter the address emails are sent from", { fromAddress: "Enter an email address" });
  }
  if (next.appUrl && !/^https?:\/\/[^\s/]+/.test(next.appUrl)) {
    throw new HttpError(400, "Links must start with http:// or https://", { appUrl: "e.g. http://10.14.5.15" });
  }
  if (!validTimeZone(next.timeZone)) throw new HttpError(400, "Unknown time zone", { timeZone: "e.g. Asia/Kolkata" });

  await query(
    `INSERT INTO app_state (key, value) VALUES ('mail', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(next)]
  );
  forgetMailSettings();
  return next;
}
