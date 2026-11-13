import type { PermissionMap, Permissions } from "../types.js";

// A person's rights when they have several roles (their main role plus app
// roles), per table:
//   - if any role lets them see the whole table (view without "own only"),
//     they get what those roles allow together. "Own only" extras from other
//     roles are dropped for that table: seeing everyone matters more than
//     editing your own entry (e.g. the People directory);
//   - otherwise, what the "own only" roles allow together, still own only.
// So nobody ever gets more, or a wider scope, than one of their roles gave.
export function mergePermissions(maps: PermissionMap[]): PermissionMap {
  if (maps.length === 1) return maps[0];
  const tables = new Set(maps.flatMap((m) => Object.keys(m ?? {})));
  const result: PermissionMap = {};
  for (const table of tables) {
    const grants = maps.map((m) => m?.[table]).filter((p): p is Permissions => Boolean(p?.view));
    const full = grants.filter((p) => !p.own);
    const chosen = full.length ? full : grants;
    if (!chosen.length) continue;
    result[table] = {
      view: true,
      create: chosen.some((p) => p.create),
      edit: chosen.some((p) => p.edit),
      delete: chosen.some((p) => p.delete),
      ...(full.length ? {} : { own: true }),
    };
  }
  return result;
}
