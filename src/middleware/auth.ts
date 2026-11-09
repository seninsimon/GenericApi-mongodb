import type { NextFunction, Request, Response } from "express";
import { isAdmin } from "../auth/access.js";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http.js";
import { extendSession, getSessionUser, SESSION_TTL_MS } from "../repo/userRepo.js";
import type { CurrentUser } from "../types.js";

export const SESSION_COOKIE = "erp_session";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const cookieOptions = (expires?: Date) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  // set COOKIE_SECURE=true when served over HTTPS
  secure: env.cookieSecure,
  path: "/",
  expires,
});

export const setSessionCookie = (res: Response, token: string, expires: Date) =>
  res.cookie(SESSION_COOKIE, token, cookieOptions(expires));

export const clearSessionCookie = (res: Response) => res.clearCookie(SESSION_COOKIE, cookieOptions());

// Loads the logged-in user into req.user, or responds 401.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token: string | undefined = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new HttpError(401, "Please log in");

    const session = await getSessionUser(token);
    if (!session) {
      clearSessionCookie(res);
      throw new HttpError(401, "Your session has expired, please log in again");
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
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  next(isAdmin(req.user) ? undefined : new HttpError(403, "Only admins can do this"));
}

// The logged-in user (only call after requireAuth).
export const currentUser = (req: Request): CurrentUser => {
  if (!req.user) throw new HttpError(401, "Please log in");
  return req.user;
};

// CSRF guard: state-changing API requests must carry a header that browsers
// won't add to cross-site form posts. The SPA sets it on every request.
export function requireAjaxHeader(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-requested-with") === "XMLHttpRequest") return next();
  next(new HttpError(403, "Missing X-Requested-With header"));
}
