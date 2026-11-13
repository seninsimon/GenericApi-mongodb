import { query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import type { CurrentUser } from "../types.js";
import { APP_BY_KEY, launcherApp } from "./index.js";

// "App access" on a person: for each app (as in the launcher, so Company is
// one row), No access / Staff / Manager. Each choice is the app's role of that
// level ("Projects · Manager"); for Company, the role of that level of each
// of its apps.

export type AccessOption = {
  key: string; // launcher key: "projects", "company"
  name: string;
  icon: string;
  levels: { level: string; label: string; description: string }[];
};

const LEVELS: Record<string, { rank: number; description: string }> = {
  staff: { rank: 1, description: "Everyday work; personal records (leave, time logs) only their own" },
  manager: { rank: 2, description: "Everything in it, including approvals" },
};
const rank = (level: string) => LEVELS[level]?.rank ?? 1.5;
const label = (level: string) => level.charAt(0).toUpperCase() + level.slice(1);

const launcherOf = (appKey: string) =>
  launcherApp(appKey) ?? { key: appKey, name: APP_BY_KEY.get(appKey)?.name ?? appKey, icon: "IconApps", description: "" };

const appRoles = async () =>
  (await query<{ _id: string; app_key: string; app_level: string }>(`SELECT _id, app_key, app_level FROM roles WHERE app_key IS NOT NULL`)).rows;

// The apps a person can be given access to, with the levels each offers.
export async function accessOptions(): Promise<AccessOption[]> {
  const byKey = new Map<string, AccessOption & { levelSet: Set<string> }>();
  for (const r of await appRoles()) {
    const l = launcherOf(r.app_key);
    const entry = byKey.get(l.key) ?? { key: l.key, name: l.name, icon: l.icon, levels: [], levelSet: new Set<string>() };
    entry.levelSet.add(r.app_level);
    byKey.set(l.key, entry);
  }
  return [...byKey.values()]
    .map(({ levelSet, ...o }) => ({
      ...o,
      levels: [...levelSet]
        .sort((a, b) => rank(a) - rank(b))
        .map((level) => ({ level, label: label(level), description: LEVELS[level]?.description ?? "" })),
    }))
    .sort((a, b) => (a.key === "company" ? -1 : b.key === "company" ? 1 : a.name.localeCompare(b.name)));
}

// A person's access, by app: { projects: "manager", company: "staff" }.
// For Company, the highest level they have in any of its apps.
export function accessOf(user: Pick<CurrentUser, "appRoles">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of user.appRoles) {
    const key = launcherOf(r.appKey).key;
    if (!out[key] || rank(r.appLevel) > rank(out[key])) out[key] = r.appLevel;
  }
  return out;
}

// The person's extra roles after setting `access` ({ projects: "manager",
// hr: null }); apps not mentioned keep what they had, other roles are kept.
export async function rolesForAccess(currentExtraRoleIds: string[], access: unknown): Promise<string[]> {
  if (!access || typeof access !== "object" || Array.isArray(access)) throw new HttpError(400, "appAccess must be an object");
  const rows = await appRoles();
  const byId = new Map(rows.map((r) => [r._id, r]));
  const touched = new Set(Object.keys(access));
  const result = currentExtraRoleIds.filter((id) => {
    const r = byId.get(id);
    return !r || !touched.has(launcherOf(r.app_key).key);
  });
  for (const [key, level] of Object.entries(access as Record<string, unknown>)) {
    if (level === null || level === "" || level === "none") continue;
    if (typeof level !== "string") throw new HttpError(400, "Choose an access level");
    const matching = rows.filter((r) => launcherOf(r.app_key).key === key && r.app_level === level);
    if (!matching.length) throw new HttpError(400, `There's no "${level}" access for that app`);
    result.push(...matching.map((r) => r._id));
  }
  return [...new Set(result)];
}
