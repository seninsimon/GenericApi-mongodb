import type pg from "pg";
import { dataTable } from "../db/dataTables.js";
import { query } from "../db/pool.js";
import { getSchema } from "../schema/schemaRepo.js";
import type { RecordData } from "../types.js";
import { mailEnabled } from "./mailer.js";
import { queueEmail } from "./outbox.js";
import { recordDetails, recordLink, renderEmail } from "./render.js";

// Bell notifications that also go by email. Per person ("Email me" in My
// profile): now = an email right away; daily = in the morning summary;
// never = only the bell. People without an email address only get the bell.
// Runs in the same transaction as the notification (and the change behind it).
export async function emailNotifications(
  client: pg.PoolClient,
  created: { _id: string; user_id: string }[],
  n: { title: string; body?: string; tableName?: string; recordId?: string }
) {
  if (!created.length || !(await mailEnabled())) return;
  const { rows: people } = await query<{ _id: string; email: string; email_pref: string }>(
    `SELECT _id, email, email_pref FROM users WHERE _id = ANY($1::text[]) AND is_active AND email <> '' AND email_pref <> 'never'`,
    [created.map((c) => c.user_id)],
    client
  );
  if (!people.length) return;

  // the daily ones wait for the morning summary
  const daily = new Set(people.filter((p) => p.email_pref === "daily").map((p) => p._id));
  const waiting = created.filter((c) => daily.has(c.user_id)).map((c) => c._id);
  if (waiting.length) await query(`UPDATE notifications SET digest_pending = true WHERE _id = ANY($1::bigint[])`, [waiting], client);

  const now = people.filter((p) => p.email_pref !== "daily");
  if (!now.length) return;
  // the record behind it, in a few lines, and a link to it
  let details: { label: string; value: string }[] = [];
  let href: string | null = null;
  if (n.tableName && n.recordId) {
    const schema = await getSchema(n.tableName);
    if (schema) {
      const { rows } = await query<{ data: RecordData }>(`SELECT data FROM ${dataTable(n.tableName)} WHERE _id = $1`, [n.recordId], client);
      if (rows[0]) details = await recordDetails(schema, rows[0].data, client);
      href = await recordLink(n.tableName, n.recordId);
    }
  }
  const { text, html } = await renderEmail({
    intro: n.body ? `${n.title}\n${n.body}` : n.title,
    details,
    button: { label: "Open in Zenin ERP", href },
  });
  for (const p of now) {
    await queueEmail({ userId: p._id, to: p.email, kind: "notification", subject: n.title, text, html }, client);
  }
}
