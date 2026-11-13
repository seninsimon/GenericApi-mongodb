import { query, type Db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { mailEnabled, mailErrorMessage, sendMail } from "./mailer.js";

// Emails are written to the outbox in the same transaction as the change that
// caused them (so a failed save sends nothing), then sent by the worker.
// A failed send is tried again after 1, 5 and 30 minutes, then marked failed
// (shown on Administration → Email).

export type EmailKind = "notification" | "account" | "summary" | "test";
const RETRY_MINUTES = [1, 5, 30];

export async function queueEmail(
  email: { userId: string | null; to: string; kind: EmailKind; subject: string; text: string; html: string },
  db?: Db
) {
  const { rows } = await query<{ _id: string }>(
    `INSERT INTO email_outbox (user_id, to_address, kind, subject, text_body, html_body) VALUES ($1, $2, $3, $4, $5, $6) RETURNING _id`,
    [email.userId, email.to, email.kind, email.subject.slice(0, 300), email.text, email.html],
    db
  );
  return rows[0]._id;
}

type Row = { _id: string; to_address: string; subject: string; text_body: string; html_body: string; attempts: number };

// Send what's due (the worker calls this every few seconds). `onlyId`: just
// that one (the admin's test email). Returns how many were sent.
export async function processOutbox(opts: { limit?: number; onlyId?: string } = {}) {
  if (!(await mailEnabled())) return 0;
  // take the due ones: a short lease stops two workers sending the same email
  const { rows } = await query<Row>(
    `UPDATE email_outbox SET next_attempt_at = now() + interval '10 minutes'
     WHERE _id IN (
       SELECT _id FROM email_outbox
       WHERE status = 'queued' AND next_attempt_at <= now() ${opts.onlyId ? "AND _id = $2" : ""}
       ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING _id, to_address, subject, text_body, html_body, attempts`,
    opts.onlyId ? [opts.limit ?? 20, opts.onlyId] : [opts.limit ?? 20]
  );
  let sent = 0;
  for (const row of rows) {
    try {
      await sendMail({ to: row.to_address, subject: row.subject, text: row.text_body, html: row.html_body });
      // a sent password email's link isn't kept (only the subject and who it went to)
      await query(
        `UPDATE email_outbox SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL,
           text_body = CASE WHEN kind = 'account' THEN '' ELSE text_body END,
           html_body = CASE WHEN kind = 'account' THEN '' ELSE html_body END
         WHERE _id = $1`,
        [row._id]
      );
      sent++;
    } catch (error) {
      const message = mailErrorMessage(error);
      const attempts = row.attempts + 1;
      const retryIn = RETRY_MINUTES[attempts - 1];
      await query(
        `UPDATE email_outbox SET attempts = $2, last_error = $3,
           status = CASE WHEN $4::int IS NULL THEN 'failed' ELSE 'queued' END,
           next_attempt_at = CASE WHEN $4::int IS NULL THEN next_attempt_at ELSE now() + make_interval(mins => $4::int) END
         WHERE _id = $1`,
        [row._id, attempts, message, retryIn ?? null]
      );
      logger.warn({ emailId: row._id, attempts, reason: message }, "email not sent");
    }
  }
  return sent;
}

// Administration → Email: counts and the last emails.
export async function outboxOverview() {
  const { rows: counts } = await query<{ sent_today: number; queued: number; failed: number }>(
    `SELECT count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '24 hours')::int AS sent_today,
            count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS failed
     FROM email_outbox`
  );
  const { rows: recent } = await query<{
    _id: string;
    to_address: string;
    kind: string;
    subject: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: Date;
    sent_at: Date | null;
  }>(`SELECT _id, to_address, kind, subject, status, attempts, last_error, created_at, sent_at FROM email_outbox ORDER BY created_at DESC, _id DESC LIMIT 50`);
  return {
    sentLast24h: counts[0].sent_today,
    queued: counts[0].queued,
    failed: counts[0].failed,
    recent: recent.map((r) => ({
      _id: r._id,
      to: r.to_address,
      kind: r.kind,
      subject: r.subject,
      status: r.status,
      attempts: r.attempts,
      error: r.last_error,
      createdAt: r.created_at,
      sentAt: r.sent_at,
    })),
  };
}

// keep a month of sent emails (the worker's housekeeping)
export const pruneOutbox = () => query(`DELETE FROM email_outbox WHERE created_at < now() - interval '30 days' AND status <> 'queued'`);
