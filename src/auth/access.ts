import type { Action, CurrentUser, DepartmentRef, PermissionMap, Permissions, TableSchema } from "../types.js";

// Access rules for ERP tables and records.
//
// A non-admin user can use a table when:
//   1. their role grants "view" on it, and
//   2. at least one of their departments is assigned to the table.
// Inside that table they only see/change records whose department is one of
// (their departments ∩ the table's departments).
// Admins can do everything, including records with no department.

const NONE: Permissions = Object.freeze({ view: false, create: false, edit: false, delete: false });
const ALL: Permissions = Object.freeze({ view: true, create: true, edit: true, delete: true });

export const isAdmin = (user: CurrentUser | undefined | null): boolean => Boolean(user?.role?.isAdmin);

// Departments of `schema` that `user` belongs to.
export const allowedDepartments = (user: CurrentUser, schema: TableSchema): DepartmentRef[] => {
  if (isAdmin(user)) return schema.departments;
  const mine = new Set(user.departments.map((d) => d._id));
  return schema.departments.filter((d) => mine.has(d._id));
};

// Department ids to filter records by, or null for "no filter" (admin).
export const departmentFilter = (user: CurrentUser, schema: TableSchema): string[] | null =>
  isAdmin(user) ? null : allowedDepartments(user, schema).map((d) => d._id);

export const tablePermissions = (user: CurrentUser, schema: TableSchema | null | undefined): Permissions => {
  if (!schema) return NONE;
  if (isAdmin(user)) return ALL;
  if (!allowedDepartments(user, schema).length) return NONE;

  const granted = user.role.permissions?.[schema.tableName];
  if (!granted?.view) return NONE;
  return { view: true, create: Boolean(granted.create), edit: Boolean(granted.edit), delete: Boolean(granted.delete) };
};

export const can = (user: CurrentUser, schema: TableSchema | null | undefined, action: Action) =>
  tablePermissions(user, schema)[action];

// Normalise a role's permission map; any write permission implies view.
export const normalizePermissions = (permissions: unknown): PermissionMap => {
  const result: PermissionMap = {};
  if (!permissions || typeof permissions !== "object") return result;

  for (const [tableName, raw] of Object.entries(permissions as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const perms = raw as Record<string, unknown>;
    const entry: Permissions = {
      view: Boolean(perms.view),
      create: Boolean(perms.create),
      edit: Boolean(perms.edit),
      delete: Boolean(perms.delete),
    };
    if (entry.create || entry.edit || entry.delete) entry.view = true;
    if (entry.view) result[tableName] = entry;
  }
  return result;
};
