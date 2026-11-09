import type { CurrentUser } from "../types.js";

declare global {
  namespace Express {
    interface Request {
      // set by requireAuth
      user?: CurrentUser;
      sessionToken?: string;
    }
  }
}

export {};
