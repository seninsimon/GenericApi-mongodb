import type { Request, Response } from "express";
import { query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { mailEnabled } from "../mail/mailer.js";
import { outboxOverview, processOutbox, queueEmail } from "../mail/outbox.js";
import { link, renderEmail } from "../mail/render.js";
import { getMailSettings, publicSettings, saveMailSettings } from "../mail/settings.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";

// Administration → Email (admins only).

// GET /email: the settings (never the password), whether it's working, the last emails
export async function getEmailHandler(_req: Request, res: Response) {
  res.json({ settings: publicSettings(await getMailSettings()), ready: await mailEnabled(), ...(await outboxOverview()) });
}

// PUT /email: save the settings
export async function saveEmailHandler(req: Request, res: Response) {
  const saved = await saveMailSettings((req.body ?? {}) as Record<string, unknown>);
  const { pass: _pass, ...shown } = saved;
  await audit(req, { action: "settings", entity: "email", changes: { ...shown, password: req.body?.pass ? "changed" : "kept" } });
  res.json({ message: "Email settings saved", settings: publicSettings(saved) });
}

// POST /email/test: a test email to yourself, sent right away
export async function testEmailHandler(req: Request, res: Response) {
  const me = currentUser(req);
  if (!me.email) throw new HttpError(400, "Add your email address in My profile first");
  if (!(await mailEnabled())) throw new HttpError(400, "Save the email settings first");
  const { text, html } = await renderEmail({
    intro: "It works! Zenin ERP can send email.",
    details: [
      { label: "Sent by", value: me.fullName || me.username },
      { label: "Links go to", value: (await getMailSettings()).appUrl || "(not set)" },
    ],
    button: { label: "Open Zenin ERP", href: await link("/") },
    footer: "A test email from Administration → Email.",
  });
  const id = await queueEmail({ userId: me._id, to: me.email, kind: "test", subject: "Test email from Zenin ERP", text, html });
  await processOutbox({ onlyId: id });
  const { rows } = await query<{ status: string; last_error: string | null }>(`SELECT status, last_error FROM email_outbox WHERE _id = $1`, [id]);
  if (rows[0]?.status !== "sent") {
    // tried again in the background; say why it didn't go now
    throw new HttpError(502, rows[0]?.last_error ?? "The email couldn't be sent");
  }
  res.json({ message: `Test email sent to ${me.email}` });
}

// At start-up: email settings that were put in .env (SMTP_HOST, SMTP_USER,
// SMTP_PASS, MAIL_FROM, APP_URL, …) fill Administration → Email once, while
// nothing is saved there yet. After that the app's settings count.
export async function importMailSettingsFromEnv() {
  const e = process.env;
  if (!e.SMTP_HOST || !e.SMTP_USER || !e.SMTP_PASS) return false;
  const { rows } = await query(`SELECT 1 FROM app_state WHERE key = 'mail'`);
  if (rows.length) return false;
  const from = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(e.MAIL_FROM ?? "");
  await saveMailSettings({
    enabled: true,
    provider: e.SMTP_HOST === "smtp.gmail.com" ? "gmail" : "smtp",
    host: e.SMTP_HOST,
    port: Number(e.SMTP_PORT) || 587,
    user: e.SMTP_USER,
    pass: e.SMTP_PASS,
    fromName: from?.[1]?.trim() || "Zenin ERP",
    fromAddress: from?.[2]?.trim() || e.SMTP_USER,
    appUrl: e.APP_URL ?? "",
    timeZone: e.MAIL_TIMEZONE || "Asia/Kolkata",
    summaryHour: Number(e.MAIL_SUMMARY_HOUR ?? 8),
  });
  logger.info("email settings copied from .env into Administration → Email; the SMTP_*/MAIL_* lines in .env are no longer needed");
  return true;
}
