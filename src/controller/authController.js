import {
  hashPassword,
  validateNewPassword,
  verifyDummyPassword,
  verifyPassword,
} from "../auth/password.js";
import {
  clearSessionCookie,
  SESSION_COOKIE,
  setSessionCookie,
} from "../middleware/auth.js";
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  findUserForLogin,
  getPasswordHash,
  getUserById,
  markLogin,
  updateUser,
} from "../repo/userRepository.js";
import { cleanText, isValidEmail } from "./validation.js";

/* ---- simple in-memory login throttling: 10 failures / 15 min per IP+username ---- */
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

const throttleKey = (req, username) => `${req.ip}|${String(username).toLowerCase()}`;

const isThrottled = (key) => {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
};

const recordFailure = (key) => {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    failures.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
  if (failures.size > 10000) failures.clear(); // bound memory
};

/* ---------------- handlers ---------------- */

export const login = async (req, res) => {
  const username = cleanText(req.body?.username);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  const key = throttleKey(req, username);
  if (isThrottled(key)) {
    return res
      .status(429)
      .json({ message: "Too many failed attempts. Try again in a few minutes." });
  }

  const account = await findUserForLogin(username);
  const valid = account
    ? await verifyPassword(password, account.password_hash)
    : await verifyDummyPassword(password);

  if (!account || !valid) {
    recordFailure(key);
    return res.status(401).json({ message: "Invalid username or password" });
  }
  if (!account.is_active) {
    return res.status(403).json({ message: "This account has been disabled" });
  }

  failures.delete(key);
  const { token, expiresAt } = await createSession(account._id);
  await markLogin(account._id);
  setSessionCookie(res, token, expiresAt);

  res.json({ user: await getUserById(account._id) });
};

export const logout = async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await deleteSession(token);
  clearSessionCookie(res);
  res.json({ message: "Logged out" });
};

export const me = (req, res) => {
  res.json({ user: req.user });
};

export const updateProfile = async (req, res) => {
  const { fullName, email, phone } = req.body ?? {};
  const update = {};

  if (fullName !== undefined) update.fullName = cleanText(fullName, 100);
  if (phone !== undefined) update.phone = cleanText(phone, 30);
  if (email !== undefined) {
    update.email = cleanText(email, 200);
    if (update.email && !isValidEmail(update.email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }
  }

  const user = await updateUser(req.user._id, update);
  res.json({ message: "Profile updated", user });
};

export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};

  const stored = await getPasswordHash(req.user._id);
  if (!stored || !(await verifyPassword(String(currentPassword ?? ""), stored))) {
    return res.status(400).json({ message: "Current password is incorrect" });
  }

  const problem = validateNewPassword(newPassword);
  if (problem) return res.status(400).json({ message: problem });

  await updateUser(req.user._id, { passwordHash: await hashPassword(newPassword) });
  // sign out every other device
  await deleteUserSessions(req.user._id, req.sessionToken);

  res.json({ message: "Password changed" });
};
