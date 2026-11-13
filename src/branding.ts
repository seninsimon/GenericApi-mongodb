import { createHash } from "node:crypto";
import { query } from "./db/pool.js";
import { HttpError } from "./lib/http.js";
import { uploadKeyFromUrl } from "./storage.js";

// The organization's name and logo (Administration → Branding), kept in
// app_state under "branding". Shown on the sign-in page, in the sidebar, the
// browser tab and emails. Default: "Zenin ERP" and a letter mark.

export const DEFAULT_NAME = "Zenin ERP";

export type Branding = { name: string; logoUrl: string }; // logoUrl: "/uploads/<key>" or ""

let cache: { at: number; value: Branding } | null = null;

export async function getBranding(): Promise<Branding> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const { rows } = await query<{ value: Partial<Branding> }>(`SELECT value FROM app_state WHERE key = 'branding'`);
  const saved = rows[0]?.value ?? {};
  const value = { name: saved.name?.trim() || DEFAULT_NAME, logoUrl: saved.logoUrl ?? "" };
  cache = { at: Date.now(), value };
  return value;
}

export const brandName = async () => (await getBranding()).name;

// What anyone may see (also before signing in): the name, and a version of the
// logo for the URL, so a new logo isn't hidden by the browser's cache.
export const publicBranding = (b: Branding) => ({
  name: b.name,
  logoVersion: b.logoUrl ? createHash("sha1").update(b.logoUrl).digest("hex").slice(0, 10) : null,
});

// An uploaded image ("/uploads/<key>"), or "" for none.
export const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
export function imageUpload(raw: unknown, label: string, allowSvg = false): string {
  if (raw === "" || raw === null) return "";
  const url = typeof raw === "string" ? raw.trim() : "";
  const key = uploadKeyFromUrl(url);
  if (!key || !(IMAGE.test(key) || (allowSvg && /\.svg$/i.test(key)))) {
    throw new HttpError(400, `${label} must be an uploaded image (PNG, JPG, WebP${allowSvg ? ", SVG" : ""})`);
  }
  return url;
}

export async function saveBranding(input: Record<string, unknown>): Promise<{ before: Branding; after: Branding }> {
  const before = await getBranding();
  const after = { ...before };
  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
    if (!name) throw new HttpError(400, "Give the ERP a name", { name: "Required" });
    if (name.length > 40) throw new HttpError(400, "Keep the name under 40 characters", { name: "At most 40 characters" });
    after.name = name;
  }
  if (input.logoUrl !== undefined) after.logoUrl = imageUpload(input.logoUrl, "The logo", true);
  await query(
    `INSERT INTO app_state (key, value) VALUES ('branding', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(after)]
  );
  cache = null;
  return { before, after };
}
