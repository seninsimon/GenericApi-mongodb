import { createHash, randomBytes } from "node:crypto";
import { query, withTransaction, type Db } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { mailEnabled } from "../mail/mailer.js";
import { queueEmail } from "../mail/outbox.js";
import { link, renderEmail } from "../mail/render.js";
import { deleteUserSessions } from "../repo/userRepo.js";
import type { CurrentUser } from "../types.js";
import { hashPassword, validateNewPassword } from "./password.js";
import { brandName } from "../branding.js";

// "Set your password" links, sent by email:
//   invite: a new person's welcome email (valid 3 days)
//   reset:  "Forgot password?" on the sign-in page (valid 1 hour)
// Only a hash of the token is kept; a link works once.

type Purpose = "invite" | "reset";
const VALID_HOURS: Record<Purpose, number> = { invite: 72, reset: 1 };
const MAX_PER_HOUR = 3; // links per person per hour

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// Make a link and queue the email. Returns false when it can't be sent
// (no address, email not set up, too many just now).
export async function sendPasswordLink(person: Pick<CurrentUser, "_id" | "username" | "fullName" | "email" | "isActive">, purpose: Purpose, db?: Db) {
  if (!person.isActive || !person.email || !(await mailEnabled())) return false;
  const base = await link("/set-password");
  if (!base) throw new HttpError(400, 'Set "Links in emails go to" in Administration → Email first');
  const { rows: recent } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM password_tokens WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
    [person._id],
    db
  );
  if (recent[0].n >= MAX_PER_HOUR) return false;

  const token = randomBytes(32).toString("base64url");
  // the newest link is the only one that works
  await query(`UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [person._id], db);
  await query(
    `INSERT INTO password_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [hash(token), person._id, purpose, VALID_HOURS[purpose]],
    db
  );
  const href = `${base}?token=${token}`;
  const brand = await brandName();
  const name = (person.fullName || person.username).split(/\s+/)[0];
  const { text, html } =
    purpose === "invite"
      ? await renderEmail({
          intro: `Hi ${name}, you have an account in ${brand}. Choose a password to start.`,
          details: [{ label: "Your username", value: person.username }],
          button: { label: "Set my password", href },
          footer: "The link works once, for 3 days. If it has expired, use \"Forgot password?\" on the sign-in page.",
        })
      : await renderEmail({
          intro: `Hi ${name}, someone asked to reset your ${brand} password. If it was you, choose a new one.`,
          details: [{ label: "Your username", value: person.username }],
          button: { label: "Choose a new password", href },
          footer: "The link works once, for 1 hour. If you didn't ask for this, ignore this email: your password stays as it is.",
        });
  await queueEmail(
    {
      userId: person._id,
      to: person.email,
      kind: "account",
      subject: purpose === "invite" ? `Welcome to ${brand}: set your password` : `Reset your ${brand} password`,
      text,
      html,
    },
    db
  );
  return true;
}

// Who a link is for (the set-password page shows their name and username).
export async function linkOwner(token: string) {
  const { rows } = await query<{ username: string; full_name: string; purpose: Purpose }>(
    `SELECT u.username, u.full_name, t.purpose FROM password_tokens t JOIN users u ON u._id = t.user_id
     WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.is_active`,
    [hash(token)]
  );
  return rows[0] ? { username: rows[0].username, fullName: rows[0].full_name, purpose: rows[0].purpose } : null;
}

// Use a link: set the password, sign them out everywhere else.
export async function usePasswordLink(token: string, password: unknown) {
  const problem = validateNewPassword(password);
  if (problem) throw new HttpError(400, problem, { password: problem });
  const passwordHash = await hashPassword(String(password));
  const userId = await withTransaction(async (client) => {
    const { rows } = await query<{ user_id: string }>(
      `UPDATE password_tokens t SET used_at = now()
       FROM users u
       WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u._id = t.user_id AND u.is_active
       RETURNING t.user_id`,
      [hash(token)],
      client
    );
    if (!rows[0]) throw new HttpError(400, "This link has expired or was already used. Ask for a new one with \"Forgot password?\".");
    await query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE _id = $1`, [rows[0].user_id, passwordHash], client);
    await query(`UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [rows[0].user_id], client);
    return rows[0].user_id;
  });
  await deleteUserSessions(userId);
  return userId;
}

// A password nobody knows: for people added with "email them a link".
export const unusablePasswordHash = () => hashPassword(randomBytes(32).toString("base64url"));
