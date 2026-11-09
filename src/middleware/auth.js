import { isAdmin } from "../auth/access.js";
import { extendSession, getSessionUser, SESSION_TTL_MS } from "../repo/userRepository.js";

export const SESSION_COOKIE = "erp_session";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const sessionCookieOptions = (expires) => ({
  httpOnly: true,
  sameSite: "lax",
  // set COOKIE_SECURE=true when the app is served over HTTPS
  secure: process.env.COOKIE_SECURE === "true",
  path: "/",
  expires,
});

export const setSessionCookie = (res, token, expires) =>
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions(expires));

export const clearSessionCookie = (res) =>
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), expires: undefined });

// Loads the logged-in user into req.user, or responds 401.
export const requireAuth = async (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    return res.status(401).json({ message: "Please log in" });
  }

  try {
    const session = await getSessionUser(token);
    if (!session) {
      clearSessionCookie(res);
      return res.status(401).json({ message: "Your session has expired, please log in again" });
    }

    // sliding expiry, refreshed at most once a day
    if (new Date(session.expiresAt).getTime() - Date.now() < SESSION_TTL_MS - ONE_DAY_MS) {
      setSessionCookie(res, token, await extendSession(token));
    }

    req.user = session.user;
    req.sessionToken = token;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAdmin = (req, res, next) => {
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: "Only admins can do this" });
  }
  next();
};
