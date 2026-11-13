import { createHash } from "node:crypto";
import { z } from "zod";
import { generateJson } from "../ai/generate.js";
import type { Who } from "../ai/usage.js";
import { query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { normalizeColumn } from "../schema/columns.js";
import { checkFormulas } from "../schema/formula.js";
import type { Column } from "../types.js";
import { autonum, bool, choice, date, file, formula, image, link, longText, managerRole, num, staffRole, text, user, WORK } from "./dsl.js";
import { APP_BY_KEY } from "./index.js";
import type { AppBlueprint, ColumnBlueprint } from "./types.js";

// "We're a 12-person dental clinic with two branches" -> the AI chosen in
// Administration → AI drafts an app
// (tables, columns, links) as structured JSON. The draft is only data: it is
// turned into a normal blueprint here, checked like every catalog app, and
// shown in the same preview before anything is created.

// What the AI fills in. Every field is required (empty when not used) so the
// structured output stays simple.
const DraftColumn = z.object({
  name: z.string().describe("snake_case identifier, unique in the table"),
  label: z.string().describe("short label shown to people, sentence case"),
  type: z
    .enum(["text", "textarea", "number", "date", "boolean", "choice", "user", "relation", "autonumber", "formula", "file", "image"])
    .describe("text first for the record's name; choice for statuses/types; user for a person with a login; relation links a record of another table"),
  required: z.boolean(),
  options: z.array(z.string()).describe("choice: the options in workflow order (first is the default); otherwise []"),
  ref: z.string().describe("relation: the key of the linked table in this draft; otherwise empty"),
  prefix: z.string().describe("autonumber: a short prefix like INV- or PAT-; otherwise empty"),
  expression: z.string().describe("formula: e.g. {qty} * {rate} or DAYS({to}, {from}) + 1; otherwise empty"),
});
const DraftTable = z.object({
  key: z.string().describe("snake_case, plural, unique: e.g. appointments"),
  label: z.string().describe("plural, sentence case: e.g. Appointments"),
  description: z.string().describe("one short line: what it keeps"),
  columns: z.array(DraftColumn),
});
export const DraftSchema = z.object({
  name: z.string().describe("the app's name, 1-3 words"),
  description: z.string().describe("one sentence: what it's for"),
  tables: z.array(DraftTable),
});
export type Draft = z.infer<typeof DraftSchema>;

const SYSTEM = `You design the tables for a small no-code ERP, from a description of an organization.

Make a compact, practical set: 2 to 7 tables, each with 4 to 10 columns, that the people described would actually use every day. Prefer fewer, clearer tables over completeness.

Rules:
- Each table's first column is a text column that names a record (e.g. "Name", "Subject"), unless the table is a document numbered with an autonumber (invoices, orders), which then comes first.
- Use choice columns for statuses, types and categories, with 3 to 6 options in workflow order.
- Use "user" for people who log in (assignee, owner, doctor); use "relation" with ref = another table's key for links between the tables you design.
- Use autonumber for documents that need a reference (prefix like INV-).
- Use formula only for simple arithmetic between number columns of the same table ({qty} * {rate}), or DAYS({to}, {from}) + 1 for dates.
- Use plain words a non-technical office worker understands. Never invent features the ERP doesn't have (no reminders, no email).`;

export const draftWithAi = (description: string, who: Who): Promise<Draft> =>
  generateJson("draftApps", who, { system: SYSTEM, prompt: `Our organization: ${description}`, schema: DraftSchema, name: "app_draft" });

/* ---------------- draft -> blueprint ---------------- */

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "item";

// Turn a draft into a blueprint. Anything that doesn't fit (a link to a table
// that isn't there, a formula that doesn't check out) is left out rather than
// failing the whole draft. The key comes from the content, so the preview and
// the install of the same draft agree.
export function fromDraft(raw: unknown): AppBlueprint {
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "That draft isn't in the expected shape");
  const draft = parsed.data;
  if (!draft.tables.length || draft.tables.length > 12) throw new HttpError(400, "A draft needs 1 to 12 tables");
  const hash = createHash("sha1").update(JSON.stringify(draft)).digest("hex").slice(0, 6);
  const key = `custom-${slug(draft.name).replace(/_/g, "-").slice(0, 24)}-${hash}`;

  const tableKeys = new Set<string>();
  const tables = draft.tables.slice(0, 12).map((t) => {
    let k = slug(t.key || t.label);
    while (tableKeys.has(k)) k = `${k}_2`;
    tableKeys.add(k);
    return { draft: t, key: k };
  });
  const byDraftKey = new Map(tables.map((t) => [t.draft.key, t.key]));

  const blueprintTables = tables.map(({ draft: t, key: tKey }) => {
    const names = new Set<string>();
    const columns: ColumnBlueprint[] = [];
    for (const c of t.columns.slice(0, 30)) {
      const name = slug(c.name || c.label);
      if (names.has(name)) continue;
      names.add(name);
      const label = (c.label || c.name).trim().slice(0, 100) || name;
      const extra = { required: c.required };
      switch (c.type) {
        case "text":
          columns.push(text(name, label, { ...extra, indexed: columns.length === 0 }));
          break;
        case "textarea":
          columns.push(longText(name, label, { showInTable: false }));
          break;
        case "number":
          columns.push(num(name, label, extra));
          break;
        case "date":
          columns.push(date(name, label, extra));
          break;
        case "boolean":
          columns.push(bool(name, label));
          break;
        case "choice": {
          const options = [...new Set(c.options.map((o) => o.trim()).filter(Boolean))].slice(0, 20);
          if (options.length) columns.push(choice(name, label, options, { ...extra, default: options[0] }));
          break;
        }
        case "user":
          columns.push(user(name, label, extra));
          break;
        case "relation": {
          const ref = byDraftKey.get(c.ref);
          if (ref) columns.push(link(name, label, ref, extra));
          break;
        }
        case "autonumber":
          columns.push(autonum(name, label, (c.prefix || `${label.slice(0, 3).toUpperCase()}-`).slice(0, 10)));
          break;
        case "formula":
          if (c.expression.trim()) columns.push(formula(name, label, c.expression.trim().slice(0, 500)));
          break;
        case "file":
          columns.push(file(name, label, { showInTable: false }));
          break;
        case "image":
          columns.push(image(name, label, { showInTable: false }));
          break;
      }
    }
    return { key: tKey, name: tKey, label: t.label.slice(0, 100) || tKey, description: t.description.slice(0, 200), columns };
  });

  // formulas that don't check out are left out; each is tried with the plain
  // columns and the formulas already accepted, so one bad formula costs only itself
  const asColumn = (c: ColumnBlueprint) =>
    normalizeColumn({ ...c, ...(c.type === "relation" ? { ref: "x" } : {}) } as Record<string, unknown> & { name: string }) as Column;
  for (const t of blueprintTables) {
    const accepted: ColumnBlueprint[] = [];
    for (const c of t.columns.filter((x) => x.type === "formula")) {
      try {
        checkFormulas([...t.columns.filter((x) => x.type !== "formula"), ...accepted, c].map(asColumn));
        accepted.push(c);
      } catch {
        // left out
      }
    }
    t.columns = t.columns.filter((c) => c.type !== "formula" || accepted.includes(c));
    if (!t.columns.some((c) => c.type === "text" || c.type === "autonumber")) t.columns.unshift(text("name", "Name", { required: true }));
  }

  return {
    key,
    version: 1,
    name: draft.name.slice(0, 60) || "Custom app",
    description: draft.description.slice(0, 300),
    icon: "IconSparkles",
    tables: blueprintTables.map((t, i) => ({ ...t, optional: i !== 0 })),
    roles: [managerRole(), staffRole(Object.fromEntries(blueprintTables.map((t) => [t.key, WORK])))],
  };
}

// Make a drafted app known to the installer (by its key).
export function registerApp(app: AppBlueprint) {
  if (!APP_BY_KEY.has(app.key)) APP_BY_KEY.set(app.key, app);
  return app;
}

// Drafted apps that were installed: their drafts are kept with the install,
// so they can be listed and removed later (also after a restart).
export async function loadDraftedApps() {
  const { rows } = await query<{ key: string; options: { draft?: unknown } }>(
    `SELECT key, options FROM installed_apps WHERE key LIKE 'custom-%'`
  );
  for (const row of rows) {
    if (APP_BY_KEY.has(row.key) || !row.options?.draft) continue;
    try {
      const app = fromDraft(row.options.draft);
      APP_BY_KEY.set(row.key, { ...app, key: row.key });
    } catch {
      // an old draft that no longer reads: the app still shows by key
    }
  }
}
