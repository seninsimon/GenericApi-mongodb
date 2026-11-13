import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../config/env.js";
import { getMailSettings, type MailSettings } from "./settings.js";

// Sending one email (the outbox decides when). The server and login come from
// Administration → Email; Gmail is smtp.gmail.com:587 with STARTTLS and an app
// password.

export type Mail = { to: string; subject: string; text: string; html: string };

const ready = (s: MailSettings) => s.enabled && Boolean(s.host && s.user && s.pass && s.fromAddress);

export async function mailEnabled() {
  return env.mailTransport === "memory" || ready(await getMailSettings());
}

// tests (MAIL_TRANSPORT=memory): emails land here instead; failNext makes the
// next sends fail, to test retries
export const memoryMailbox: Mail[] = [];
export const memoryControl = { failNext: 0 };

// one connection pool, made again when the settings change
let transporter: { key: string; t: Transporter } | null = null;
function transport(s: MailSettings) {
  const key = JSON.stringify([s.host, s.port, s.user, s.pass]);
  if (transporter?.key !== key) {
    transporter?.t.close();
    transporter = {
      key,
      t: nodemailer.createTransport({
        host: s.host,
        port: s.port,
        secure: s.port === 465, // 587: STARTTLS
        requireTLS: s.port !== 465,
        auth: { user: s.user, pass: s.pass },
        pool: true,
        maxConnections: 2,
        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 30_000,
      }),
    };
  }
  return transporter.t;
}

const quoted = (name: string) => `"${name.replace(/["\\]/g, "")}"`;

export async function sendMail(mail: Mail) {
  if (env.mailTransport === "memory") {
    if (memoryControl.failNext > 0) {
      memoryControl.failNext--;
      throw new Error("The mail server didn't answer (test)");
    }
    memoryMailbox.push(mail);
    return;
  }
  const s = await getMailSettings();
  if (!ready(s)) throw new Error("Email isn't set up");
  await transport(s).sendMail({ from: `${quoted(s.fromName)} <${s.fromAddress}>`, ...mail });
}

// A reason people can act on, without anything secret in it.
export function mailErrorMessage(error: unknown): string {
  const e = error as { code?: string; responseCode?: number; message?: string };
  if (e.code === "EAUTH" || e.responseCode === 535) return "The mail server refused the login: check the address and the app password in Administration → Email";
  if (e.code === "ECONNECTION" || e.code === "ETIMEDOUT" || e.code === "ESOCKET" || e.code === "EDNS") {
    return "Couldn't reach the mail server (no internet, or the server or port is wrong)";
  }
  if (e.responseCode === 550 || e.responseCode === 553) return "The address was refused by the mail server";
  if (e.responseCode && e.responseCode >= 400 && e.responseCode < 500) return "The mail server asked to try later (e.g. the daily sending limit)";
  return (e.message ?? "Sending failed").slice(0, 300);
}
