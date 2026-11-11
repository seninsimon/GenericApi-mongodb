import type { Action, CurrentUser, DepartmentRef, PermissionMap, Permissions, RecordScope, TableSchema } from "../types.js";

// Access rules for ERP tables and records.
//
// A non-admin user can use a table when:
//   1. their role grants "view" on it, and
//   2. at least one of their departments is assigned to the table.
// Inside that table they only see/change records whose department is one of
// (their departments ∩ the table's departments). If their role has "own only"
// for the table, they instead see just their own records (created by them, or
// picked in a "User" column), whichever of the table's departments those are
// in: e.g. HR keeps employee records "visible to HR", and each person still
// sees their own.
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

// Every record (admins, and internal use).
export const ALL_RECORDS: RecordScope = Object.freeze({ departmentIds: null, owner: null });

// Which records of `schema` the user can see and change. Every record query
// goes through this, so "own only" applies to lists, single records, edits,
// deletes, exports, history and links from other tables alike.
export const recordScope = (user: CurrentUser, schema: TableSchema): RecordScope => {
  if (isAdmin(user)) return ALL_RECORDS;
  if (tablePermissions(user, schema).own) {
    // ownership replaces the department rule (table access still needs a shared department)
    return {
      departmentIds: null,
      owner: { userId: user._id, userColumns: schema.columns.filter((c) => c.type === "user").map((c) => c.name) },
    };
  }
  return { departmentIds: allowedDepartments(user, schema).map((d) => d._id), owner: null };
};

export const tablePermissions = (user: CurrentUser, schema: TableSchema | null | undefined): Permissions => {
  if (!schema) return NONE;
  if (isAdmin(user)) return ALL;
  if (!allowedDepartments(user, schema).length) return NONE;

  const granted = user.role.permissions?.[schema.tableName];
  if (!granted?.view) return NONE;
  return {
    view: true,
    create: Boolean(granted.create),
    edit: Boolean(granted.edit),
    delete: Boolean(granted.delete),
    own: Boolean(granted.own),
  };
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
    if (perms.own) entry.own = true;
    if (entry.view) result[tableName] = entry;
  }
  return result;
};
