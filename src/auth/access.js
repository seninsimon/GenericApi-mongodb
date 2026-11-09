// Access rules for ERP tables and records.
//
// A non-admin user can use a table when:
//   1. their role grants "view" on it, and
//   2. at least one of their departments is assigned to the table.
// Inside that table they only see/change records whose department is one of
// (their departments ∩ the table's departments).
// Admins can do everything, including records with no department.

export const ACTIONS = ["view", "create", "edit", "delete"];

const NONE = Object.freeze({ view: false, create: false, edit: false, delete: false });
const ALL = Object.freeze({ view: true, create: true, edit: true, delete: true });

export const isAdmin = (user) => Boolean(user?.role?.isAdmin);

// Departments of `schema` that `user` belongs to ([{ _id, name }])
export const allowedDepartments = (user, schema) => {
  const tableDepartments = schema?.departments ?? [];
  if (isAdmin(user)) return tableDepartments;
  const mine = new Set((user?.departments ?? []).map((d) => d._id));
  return tableDepartments.filter((d) => mine.has(d._id));
};

// Department ids to filter records by, or null for "no filter" (admin).
export const departmentFilter = (user, schema) =>
  isAdmin(user) ? null : allowedDepartments(user, schema).map((d) => d._id);

// Effective { view, create, edit, delete } of `user` on `schema`.
export const tablePermissions = (user, schema) => {
  if (!schema) return NONE;
  if (isAdmin(user)) return ALL;
  if (!allowedDepartments(user, schema).length) return NONE;

  const granted = user?.role?.permissions?.[schema.tableName];
  if (!granted?.view) return NONE;

  return {
    view: true,
    create: Boolean(granted.create),
    edit: Boolean(granted.edit),
    delete: Boolean(granted.delete),
  };
};

export const can = (user, schema, action) => tablePermissions(user, schema)[action] === true;

// Normalise a role's permission map; any write permission implies view.
export const normalizePermissions = (permissions) => {
  const result = {};
  if (!permissions || typeof permissions !== "object") return result;

  for (const [tableName, perms] of Object.entries(permissions)) {
    if (!perms || typeof perms !== "object") continue;
    const entry = {
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
