import type { NextFunction, Request, RequestHandler, Response } from "express";

// An error with an HTTP status; `errors` carries per-field validation messages.
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors?: Record<string, string>
  ) {
    super(message);
  }
}

// Wrap an async route handler: errors become JSON responses.
export const handle =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };

/* ---------------- input helpers ---------------- */

export const cleanText = (value: unknown, maxLength = 200): string =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,50}$/;

export const toIdList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0))]
    : [];

export const intParam = (value: unknown, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export const param = (req: Request, name: string): string => {
  const value = req.params[name];
  return Array.isArray(value) ? value.join("/") : String(value ?? "");
};
