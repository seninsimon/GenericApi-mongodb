import type { Request, Response } from "express";
import { allowedDepartments, can, isAdmin, tablePermissions } from "../auth/access.js";
import { HttpError, param, toIdList } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import { assignUnassigned, countUnassigned } from "../repo/recordRepo.js";
import { existingDepartmentIds } from "../repo/userRepo.js";
import { FILE_COLUMN_TYPES } from "../schema/columns.js";
import {
  addColumn,
  createTable,
  deleteColumn,
  deleteTable,
  findRelationsTo,
  getAllSchemas,
  getSchema,
  updateColumn,
  updateTableSettings,
} from "../schema/schemaRepo.js";
import { deleteUploads } from "../storage.js";
import type { CurrentUser, TableSchema } from "../types.js";

// What the current user may do with a table, added to the schema.
const withAccess = (user: CurrentUser, schema: TableSchema) => ({
  ...schema,
  permissions: tablePermissions(user, schema),
  allowedDepartments: allowedDepartments(user, schema),
});

const requireTable = async (name: string) => {
  const schema = await getSchema(name);
  if (!schema) throw new HttpError(404, "Table not found");
  return schema;
};

// Admins get every table; other users only the ones they can view.
export async function getTables(req: Request, res: Response) {
  const user = currentUser(req);
  const schemas = await getAllSchemas();
  res.json(schemas.filter((s) => can(user, s, "view")).map((s) => withAccess(user, s)));
}

export async function getTableSchema(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await getSchema(param(req, "table"));
  if (!schema || !can(user, schema, "view")) throw new HttpError(404, "Table not found");

  const result: Record<string, unknown> = withAccess(user, schema);
  if (isAdmin(user)) result.unassignedCount = await countUnassigned(schema.tableName);
  res.json(result);
}

/* ---------------- admin: tables ---------------- */

export async function createTableHandler(req: Request, res: Response) {
  const schema = await createTable(req.body ?? {});
  await audit(req, { action: "create", entity: "table", tableName: schema.tableName });
  res.json({ message: "Table created", data: schema });
}

export async function deleteTableHandler(req: Request, res: Response) {
  const schema = await requireTable(param(req, "table"));

  // don't leave relation columns in other tables pointing at nothing
  const references = await findRelationsTo(schema.tableName);
  if (references.length) {
    const list = references.map((r) => `${r.tableName}.${r.column}`).join(", ");
    throw new HttpError(409, `Other tables link to "${schema.tableName}" (${list}). Delete those relation columns first.`);
  }

  const fileColumns = schema.columns.filter((c) => FILE_COLUMN_TYPES.includes(c.type)).map((c) => c.name);
  const fileUrls = await deleteTable(schema, fileColumns);
  await deleteUploads(fileUrls);
  await audit(req, { action: "delete", entity: "table", tableName: schema.tableName, changes: { deletedFiles: fileUrls.length } });

  res.json({ message: `Table "${schema.tableName}" deleted`, deletedFiles: fileUrls.length });
}

// PUT /schema/:table { showInMenu?, departmentIds? }
export async function updateTableSettingsHandler(req: Request, res: Response) {
  const tableName = param(req, "table");
  let departmentIds: string[] | undefined;
  if (req.body?.departmentIds !== undefined) {
    departmentIds = toIdList(req.body.departmentIds);
    if ((await existingDepartmentIds(departmentIds)).length !== departmentIds.length) {
      throw new HttpError(400, "Unknown department selected");
    }
  }
  const schema = await updateTableSettings(tableName, { showInMenu: req.body?.showInMenu, departmentIds });
  await audit(req, {
    action: "settings",
    entity: "table",
    tableName,
    changes: { showInMenu: schema.showInMenu, departments: schema.departments.map((d) => d.name) },
  });
  res.json({ message: "Table settings updated", data: schema });
}

// PUT /schema/:table/unassigned { departmentId }: records without a department go there
export async function assignUnassignedHandler(req: Request, res: Response) {
  const schema = await requireTable(param(req, "table"));
  const department = schema.departments.find((d) => d._id === req.body?.departmentId);
  if (!department) throw new HttpError(400, "Choose one of this table's departments");

  const updated = await assignUnassigned(schema.tableName, department._id);
  await audit(req, {
    action: "assign_unassigned",
    entity: "table",
    tableName: schema.tableName,
    changes: { department: department.name, records: updated },
  });
  res.json({ message: `${updated} record(s) assigned`, updated });
}

/* ---------------- admin: columns ---------------- */

export async function addColumnHandler(req: Request, res: Response) {
  const tableName = param(req, "table");
  const { column } = await addColumn(tableName, req.body ?? {});
  await audit(req, { action: "create", entity: "column", tableName, recordId: column.name, changes: column });
  res.json({ message: "Column added", data: column });
}

export async function updateColumnHandler(req: Request, res: Response) {
  const tableName = param(req, "table");
  const { before, after } = await updateColumn(tableName, param(req, "name"), req.body ?? {});
  const changes = Object.fromEntries(
    (["label", "type", "showInTable", "required", "indexed"] as const)
      .filter((k) => before[k] !== after[k])
      .map((k) => [k, { from: before[k], to: after[k] }])
  );
  await audit(req, { action: "update", entity: "column", tableName, recordId: after.name, changes });
  res.json({ message: "Column updated successfully", data: after });
}

export async function deleteColumnHandler(req: Request, res: Response) {
  const tableName = param(req, "table");
  const { removed } = await deleteColumn(tableName, param(req, "column"));
  await audit(req, { action: "delete", entity: "column", tableName, recordId: removed.name, changes: { type: removed.type } });
  res.json({ message: "Column removed" });
}
