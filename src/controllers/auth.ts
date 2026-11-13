import { linkOwner, sendPasswordLink, usePasswordLink } from "../auth/passwordLinks.js";
import { query } from "../db/pool.js";
import { mailEnabled } from "../mail/mailer.js";
import type { Request, Response } from "express";
import { hashPassword, validateNewPassword, verifyDummyPassword, verifyPassword } from "../auth/password.js";
import { clearFailures, isThrottled, recordFailure, throttleKey } from "../auth/throttle.js";
import { cleanText, HttpError, isValidEmail } from "../lib/http.js";
import { clearSessionCookie, currentUser, SESSION_COOKIE, setSessionCookie } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  findUserForLogin,
  getPasswordHash,
  getUserById,
  markLogin,
  updateUser,
} from "../repo/userRepo.js";

export async function login(req: Request, res: Response) {
  const username = cleanText(req.body?.username, 50);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) throw new HttpError(400, "Username and password are required");

  const key = throttleKey(req.ip, username);
  if (await isThrottled(key)) throw new HttpError(429, "Too many failed attempts. Try again in a few minutes.");

  const account = await findUserForLogin(username);
  const valid = account ? await verifyPassword(password, account.password_hash) : await verifyDummyPassword(password);

  if (!account || !valid) {
    await recordFailure(key);
    await audit(req, { action: "login_failed", entity: "session", userId: account?._id ?? null, username });
    throw new HttpError(401, "Invalid username or password");
  }
  if (!account.is_active) throw new HttpError(403, "This account has been disabled");

  await clearFailures(key);
  const { token, expiresAt } = await createSession(account._id);
  await markLogin(account._id);
  setSessionCookie(res, token, expiresAt);
  await audit(req, { action: "login", entity: "session", userId: account._id, username: account.username });

  res.json({ user: await getUserById(account._id) });
}

export async function logout(req: Request, res: Response) {
  const token: string | undefined = req.cookies?.[SESSION_COOKIE];
  if (token) await deleteSession(token);
  clearSessionCookie(res);
  res.json({ message: "Logged out" });
}

export const me = (req: Request, res: Response) => res.json({ user: currentUser(req) });

export async function updateProfile(req: Request, res: Response) {
  const user = currentUser(req);
  const { fullName, email, phone, emailPref } = req.body ?? {};
  const update: { fullName?: string; email?: string; phone?: string; emailPref?: "now" | "daily" | "never" } = {};
  if (emailPref !== undefined) {
    if (!["now", "daily", "never"].includes(emailPref)) throw new HttpError(400, "Choose how often to get emails");
    update.emailPref = emailPref;
  }

  if (fullName !== undefined) update.fullName = cleanText(fullName, 100);
  if (phone !== undefined) update.phone = cleanText(phone, 30);
  if (email !== undefined) {
    update.email = cleanText(email, 200);
    if (update.email && !isValidEmail(update.email)) throw new HttpError(400, "Invalid email address");
  }

  const updated = await updateUser(user._id, update);
  await audit(req, { action: "update", entity: "user", recordId: user._id, changes: update });
  res.json({ message: "Profile updated", user: updated });
}

export async function changePassword(req: Request, res: Response) {
  const user = currentUser(req);
  const { currentPassword, newPassword } = req.body ?? {};

  const stored = await getPasswordHash(user._id);
  if (!stored || !(await verifyPassword(String(currentPassword ?? ""), stored))) {
    throw new HttpError(400, "Current password is incorrect");
  }
  const problem = validateNewPassword(newPassword);
  if (problem) throw new HttpError(400, problem);

  await updateUser(user._id, { passwordHash: await hashPassword(newPassword) });
  await deleteUserSessions(user._id, req.sessionToken); // sign out other devices
  await audit(req, { action: "password_change", entity: "user", recordId: user._id });

  res.json({ message: "Password changed" });
}

/* ---------------- password links (email) ---------------- */

// POST /auth/forgot { login }: a username or email address. The answer is the
// same whether or not the account exists (nobody can probe for accounts).
export async function forgotPassword(req: Request, res: Response) {
  const login = cleanText(req.body?.login, 200);
  if (!login) throw new HttpError(400, "Enter your username or email address");
  if (!(await mailEnabled())) {
    throw new HttpError(503, "Email isn't set up here, so ask an admin to reset your password");
  }
  const { rows } = await query<{ _id: string }>(
    `SELECT _id FROM users WHERE is_active AND (lower(username) = lower($1) OR (email <> '' AND lower(email) = lower($1))) LIMIT 2`,
    [login]
  );
  // an email address shared by two accounts: don't guess which
  if (rows.length === 1) {
    const person = await getUserById(rows[0]._id);
    if (person) {
      const sent = await sendPasswordLink(person, "reset").catch(() => false);
      if (sent) await audit(req, { action: "password_link", entity: "user", recordId: person._id, changes: { purpose: "reset" } });
    }
  }
  res.json({ message: "If that account has an email address, a link to choose a new password is on its way. Check your inbox (and spam folder)." });
}

// GET /auth/password-link?token=: who the link is for (the page greets them)
export async function passwordLinkInfo(req: Request, res: Response) {
  const owner = typeof req.query.token === "string" ? await linkOwner(req.query.token) : null;
  if (!owner) throw new HttpError(404, "This link has expired or was already used");
  res.json(owner);
}

// POST /auth/set-password { token, password }
export async function setPasswordFromLink(req: Request, res: Response) {
  const userId = await usePasswordLink(String(req.body?.token ?? ""), req.body?.password);
  await audit(req, { action: "password_change", entity: "user", recordId: userId, changes: { by: "email link" } });
  res.json({ message: "Your password is set. You can sign in now." });
}
