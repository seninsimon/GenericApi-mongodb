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
  const { fullName, email, phone } = req.body ?? {};
  const update: { fullName?: string; email?: string; phone?: string } = {};

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
