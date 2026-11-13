import { dataTable } from "../db/dataTables.js";
import { query, type Db } from "../db/pool.js";
import { departmentNames, getUserOptionsByIds, userLabel } from "../repo/userRepo.js";
import { pickDisplayField } from "../schema/columns.js";
import { getSchema } from "../schema/schemaRepo.js";
import type { Column, RecordData, TableSchema } from "../types.js";
import { getMailSettings } from "./settings.js";

// What emails look like: short, plain, readable on a phone. Every email has a
// plain-text and an HTML version.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// a full link into the ERP (null while "Links in emails go to" isn't set)
export const link = async (path: string) => {
  const base = (await getMailSettings()).appUrl;
  return base ? `${base}${path}` : null;
};
export const recordLink = (table: string, id: string) => link(`/table/${encodeURIComponent(table)}/${encodeURIComponent(id)}`);

export type Section = { heading?: string; lines: { text: string; href?: string | null }[] };

// One email from its parts. `button`: the main link ("Open in Zenin ERP").
export async function renderEmail(parts: {
  intro: string;
  details?: { label: string; value: string }[];
  sections?: Section[];
  button?: { label: string; href: string | null };
  footer?: string;
}) {
  const profile = await link("/profile");
  const footer = parts.footer ?? `You get this because it concerns you in Zenin ERP. Change how often you get emails in My profile${profile ? `: ${profile}` : "."}`;

  const text = [
    parts.intro,
    ...(parts.details?.length ? ["", ...parts.details.map((d) => `${d.label}: ${d.value}`)] : []),
    ...(parts.sections ?? []).flatMap((s) => ["", ...(s.heading ? [s.heading] : []), ...s.lines.map((l) => `- ${l.text}${l.href ? `  ${l.href}` : ""}`)]),
    ...(parts.button?.href ? ["", `${parts.button.label}: ${parts.button.href}`] : []),
    "",
    "--",
    footer,
  ].join("\n");

  const details = parts.details?.length
    ? `<table role="presentation" style="border-collapse:collapse;margin:16px 0;font-size:14px">${parts.details
        .map(
          (d) =>
            `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${esc(d.label)}</td><td style="padding:4px 0;color:#111827">${esc(d.value)}</td></tr>`
        )
        .join("")}</table>`
    : "";
  const sections = (parts.sections ?? [])
    .map(
      (s) =>
        `${s.heading ? `<h3 style="font-size:15px;margin:20px 0 6px;color:#111827">${esc(s.heading)}</h3>` : ""}<ul style="margin:0;padding-left:20px;font-size:14px;color:#111827">${s.lines
          .map((l) => `<li style="margin:4px 0">${l.href ? `<a href="${esc(l.href)}" style="color:#4f46e5">${esc(l.text)}</a>` : esc(l.text)}</li>`)
          .join("")}</ul>`
    )
    .join("");
  const button = parts.button?.href
    ? `<p style="margin:24px 0"><a href="${esc(parts.button.href)}" style="background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block">${esc(parts.button.label)}</a></p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
<p style="margin:0 0 4px;font-size:15px;line-height:1.5;color:#111827">${esc(parts.intro).replace(/\n/g, "<br>")}</p>${details}${sections}${button}
<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280">${esc(footer)}</p>
</div></body></html>`;
  return { text, html };
}

/* ---------------- a record, in a few lines ---------------- */

const SKIPPED: Column["type"][] = ["richtext", "image", "images", "file", "files"];

const dateText = (value: string) => {
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

// The record's first few fields as "label: value", for an email.
export async function recordDetails(schema: TableSchema, data: RecordData, db?: Db, max = 7) {
  const columns = schema.columns.filter((c) => c.showInTable !== false && !SKIPPED.includes(c.type)).slice(0, max);
  const ids = (v: unknown) => ([] as unknown[]).concat(v ?? []).filter((x): x is string => typeof x === "string" && x.length > 0);
  const people = await getUserOptionsByIds(columns.filter((c) => c.type === "user").flatMap((c) => ids(data[c.name])));
  const departments = columns.some((c) => c.type === "department") ? await departmentNames() : new Map<string, string>();

  const out: { label: string; value: string }[] = [];
  for (const column of columns) {
    const value = data[column.name];
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) continue;
    let text: string;
    switch (column.type) {
      case "user":
        text = ids(value).map((id) => userLabel(people, id) || "someone").join(", ");
        break;
      case "department":
        text = ids(value).map((id) => departments.get(id) ?? "").filter(Boolean).join(", ");
        break;
      case "relation": {
        const ref = column.ref ? await getSchema(column.ref) : null;
        if (!ref) continue;
        const field = pickDisplayField(ref, column.displayField);
        const { rows } = await query<{ label: string | null }>(
          `SELECT CASE WHEN $2 = '_id' THEN t._id ELSE t.data ->> $2 END AS label FROM ${dataTable(ref.tableName)} t WHERE t._id = ANY($1::text[])`,
          [ids(value), field],
          db
        );
        text = rows.map((r) => r.label ?? "").filter(Boolean).join(", ");
        break;
      }
      case "date":
        text = dateText(String(value));
        break;
      case "boolean":
        text = value ? "Yes" : "No";
        break;
      case "number":
      case "rollup":
      case "formula":
        text = typeof value === "number" ? value.toLocaleString("en-IN") : String(value);
        break;
      default:
        text = Array.isArray(value) ? value.join(", ") : String(value);
    }
    if (text) out.push({ label: column.label || column.name, value: text.length > 200 ? `${text.slice(0, 199)}…` : text });
  }
  return out;
}
