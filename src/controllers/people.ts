import type { Request, Response } from "express";
import { intParam } from "../lib/http.js";
import { getUserOptionsByIds, searchUserOptions } from "../repo/userRepo.js";

// GET /api/users/options?search=&limit=   active people for "User" columns and filters
// GET /api/users/options?ids=a,b          names for these ids (any status; deleted ones too)
//
// Open to every logged-in user (everyone can assign work to colleagues), so it
// only returns names and usernames, nothing else about the accounts.
export async function userOptionsHandler(req: Request, res: Response) {
  if (typeof req.query.ids === "string" && req.query.ids) {
    const ids = [...new Set(req.query.ids.split(",").filter(Boolean))].slice(0, 200);
    const found = await getUserOptionsByIds(ids);
    res.json(ids.map((id) => found.get(id) ?? { value: id, label: "Deleted user", username: "", isActive: false }));
    return;
  }
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
  res.json(await searchUserOptions(search, intParam(req.query.limit, 50, 1, 200)));
}
