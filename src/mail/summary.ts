import type pg from "pg";
import { listInstalled } from "../apps/installer.js";
import { APP_BY_KEY, fullKey } from "../apps/index.js";
import type { AppBlueprint, ReminderBlueprint } from "../apps/types.js";
import { dataTable } from "../db/dataTables.js";
import { query, withTransaction } from "../db/pool.js";
import { managersOf, recipients } from "../schema/automations.js";
import { pickDisplayField } from "../schema/columns.js";
import { filterConditions, parseFilters, resolveDateToken } from "../schema/filters.js";
import { getAllSchemas } from "../schema/schemaRepo.js";
import type { RecordData, TableSchema } from "../types.js";
import { mailEnabled } from "./mailer.js";
import { queueEmail } from "./outbox.js";
import { link, recordLink, renderEmail, type Section } from "./render.js";
import { getMailSettings } from "./settings.js";
import { brandName } from "../branding.js";

// The morning summary: once a day, at the hour set in Administration → Email
// (in its time zone), one email per person with what needs them:
//   - the apps' reminders ("Your tasks due by tomorrow, or overdue",
//     "Overdue invoices" for billing managers, …);
//   - for people who chose "once a day": the notifications since the last one.
// Nothing to say, no email. People who chose "never" get none.

const MAX_PER_LIST = 20;

// The date and hour now, where the organization is.
export function localNow(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const shortDate = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

// "$managers" in a reminder: the app's managers (its Manager role), else the
// people who can edit every record of the table, else the admins
async function appManagers(app: AppBlueprint, tableName: string, client: pg.PoolClient) {
  const { rows } = await query<{ _id: string }>(
    `SELECT DISTINCT u._id FROM users u
     JOIN roles r ON r._id = u.role_id OR r._id IN (SELECT role_id FROM user_roles WHERE user_id = u._id)
     WHERE u.is_active AND r.app_key = $1 AND r.app_level = 'manager'`,
    [app.key],
    client
  );
  return rows.length ? rows.map((r) => r._id) : managersOf(tableName, client);
}

// The records one reminder finds today, with who each one is for.
async function reminderItems(app: AppBlueprint, r: ReminderBlueprint, schema: TableSchema, today: string, client: pg.PoolClient) {
  const resolved = r.filters.map((f) => ({ ...f, value: resolveDateToken(f.value, today), value2: resolveDateToken(f.value2, today) }));
  let filters;
  try {
    filters = parseFilters(resolved, schema);
  } catch {
    return []; // a column it needs was renamed or removed: skip it
  }
  const params: unknown[] = [];
  const where = filterConditions(schema, filters, params);
  const { rows } = await query<{ _id: string; data: RecordData; created_by: string | null }>(
    `SELECT t._id, t.data, t.created_by FROM ${dataTable(schema.tableName)} t
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY t.created_at LIMIT 200`,
    params,
    client
  );
  const display = pickDisplayField(schema);
  const dateColumn = r.date && schema.columns.some((c) => c.name === r.date) ? r.date : null;
  const managers = r.who === "$managers" ? await appManagers(app, schema.tableName, client) : [];
  const items: { userId: string; text: string; href: string | null }[] = [];
  for (const row of rows) {
    const people = r.who === "$managers" ? managers : await recipients(schema, r.who, row.data, row.created_by, client);
    const name = String((display === "_id" ? row._id : row.data[display]) || "A record");
    const when = dateColumn && typeof row.data[dateColumn] === "string" ? ` (${shortDate(row.data[dateColumn] as string)})` : "";
    const href = await recordLink(schema.tableName, row._id);
    for (const userId of people) items.push({ userId, text: `${name}${when}`, href });
  }
  return items;
}

// Runs every few seconds from the worker; does its work once a day.
// `now`: tests pass a fixed time. Returns the number of emails queued.
export async function runMorningSummary(now = new Date()): Promise<number> {
  if (!(await mailEnabled())) return 0;
  const settings = await getMailSettings();
  const local = localNow(now, settings.timeZone);
  if (local.hour < settings.summaryHour) return 0;

  return withTransaction(async (client) => {
    // one worker, once a day
    await query(`SELECT pg_advisory_xact_lock(hashtext('erp_morning_summary'))`, [], client);
    const { rows: state } = await query<{ value: { date?: string } }>(`SELECT value FROM app_state WHERE key = 'mail_summary'`, [], client);
    if (state[0]?.value?.date === local.date) return 0;
    await query(
      `INSERT INTO app_state (key, value) VALUES ('mail_summary', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ date: local.date })],
      client
    );

    const sections = new Map<string, Section[]>(); // user -> their lists
    const add = (userId: string, heading: string, line: { text: string; href: string | null }) => {
      const list = sections.get(userId) ?? [];
      let section = list.find((s) => s.heading === heading);
      if (!section) list.push((section = { heading, lines: [] }));
      if (section.lines.length < MAX_PER_LIST) section.lines.push(line);
      sections.set(userId, list);
    };

    // 1. the apps' reminders
    const schemas = await getAllSchemas();
    for (const installed of await listInstalled()) {
      const app = APP_BY_KEY.get(installed.key);
      for (const r of app?.reminders ?? []) {
        const schema = schemas.find((s) => s.blueprintKey === fullKey(app!, r.table));
        if (!schema) continue;
        for (const item of await reminderItems(app!, r, schema, local.date, client)) add(item.userId, r.label, item);
      }
    }

    // 2. "once a day" people: the notifications since the last summary
    const { rows: waiting } = await query<{ _id: string; user_id: string; title: string; table_name: string | null; record_id: string | null }>(
      `UPDATE notifications SET digest_pending = false WHERE digest_pending
       RETURNING _id, user_id, title, table_name, record_id`,
      [],
      client
    );
    for (const n of waiting.sort((a, b) => Number(a._id) - Number(b._id))) {
      add(n.user_id, "Updates since yesterday", { text: n.title, href: n.table_name && n.record_id ? await recordLink(n.table_name, n.record_id) : null });
    }

    // 3. one email each
    if (!sections.size) return 0;
    const { rows: people } = await query<{ _id: string; email: string; full_name: string; username: string }>(
      `SELECT _id, email, full_name, username FROM users WHERE _id = ANY($1::text[]) AND is_active AND email <> '' AND email_pref <> 'never'`,
      [[...sections.keys()]],
      client
    );
    const home = await link("/");
    const brand = await brandName();
    for (const p of people) {
      const lists = sections.get(p._id)!;
      const count = lists.reduce((n, s) => n + s.lines.length, 0);
      const first = (p.full_name || p.username).split(/\s+/)[0];
      const { text, html } = await renderEmail({
        intro: `Good morning, ${first}. Here's what needs you today.`,
        sections: lists,
        button: { label: `Open ${brand}`, href: home },
      });
      await queueEmail(
        { userId: p._id, to: p.email, kind: "summary", subject: `Your day, ${longDate(local.date)}: ${count} ${count === 1 ? "thing" : "things"}`, text, html },
        client
      );
    }
    return people.length;
  });
}
