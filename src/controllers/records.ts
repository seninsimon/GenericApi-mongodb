import type { Request, Response } from "express";
import { allowedDepartments, can, departmentFilter, isAdmin } from "../auth/access.js";
import { withTransaction } from "../db/pool.js";
import { HttpError, intParam, param } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit, diffRecord, snapshot } from "../repo/auditRepo.js";
import {
  deleteRecord,
  getRecord,
  getRecordOptions,
  getRecordsByIds,
  insertRecord,
  listRecords,
  lockRecord,
  updateRecord,
} from "../repo/recordRepo.js";
import { columnByNameOrLabel, FILE_COLUMN_TYPES, INDEXABLE_TYPES, pickDisplayField } from "../schema/columns.js";
import { getSchema } from "../schema/schemaRepo.js";
import { checkRelations, checkRequired, coerceValues } from "../schema/validateRecord.js";
import { deleteUploads } from "../storage.js";
import type { Action, CurrentUser, RecordData, TableSchema } from "../types.js";
import { htmlToText } from "../lib/text.js";

const VERBS: Record<Action, string> = { view: "view", create: "add", edit: "edit", delete: "delete" };

// The table's schema, if the user may perform `action` on it. Tables the user
// can't see at all are reported as 404 so they stay hidden.
export async function loadTable(req: Request, action: Action): Promise<TableSchema> {
  const user = currentUser(req);
  const schema = await getSchema(param(req, "collection"));
  if (!schema || !can(user, schema, "view")) throw new HttpError(404, "Table not found");
  if (!can(user, schema, action)) {
    throw new HttpError(403, `You don't have permission to ${VERBS[action]} records in this table`);
  }
  return schema;
}

const departmentError = (message: string) => new HttpError(400, message, { _departmentId: message });

// Which department a created/edited record goes to. `requested` is the
// payload's _departmentId (undefined = not sent = keep for edits).
export function resolveDepartment(
  user: CurrentUser,
  schema: TableSchema,
  requested: unknown,
  creating: boolean
): string | null | undefined {
  const allowed = allowedDepartments(user, schema).map((d) => d._id);

  if (requested === undefined) {
    if (!creating) return undefined;
    if (allowed.length === 1) return allowed[0];
    if (allowed.length === 0 && isAdmin(user)) return null;
    throw departmentError("Please choose a department for this record");
  }
  if (requested === null || requested === "") {
    if (isAdmin(user)) return null; // admins may leave records unassigned
    throw departmentError("Please choose a department for this record");
  }
  if (typeof requested !== "string" || !allowed.includes(requested)) {
    throw departmentError("You can't assign records to that department");
  }
  return requested;
}

const throwIfErrors = (errors: Record<string, string>) => {
  const messages = Object.values(errors);
  if (messages.length) throw new HttpError(400, messages.join("; "), errors);
};

const fileUrls = (value: unknown): string[] =>
  ([] as unknown[]).concat(value ?? []).filter((v): v is string => typeof v === "string" && v.length > 0);

const departmentName = (schema: TableSchema, id: string | null | undefined) =>
  id ? (schema.departments.find((d) => d._id === id)?.name ?? id) : null;

/* ---------------- list ---------------- */

export async function listHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "view");

  const sortKey = typeof req.query.sort === "string" ? req.query.sort : "";
  const sortColumn = sortKey ? columnByNameOrLabel(schema, sortKey) : undefined;
  const page = intParam(req.query.page, 1, 1, 1_000_000);
  const limit = intParam(req.query.limit, 10, 1, 500);

  const result = await listRecords(schema.tableName, {
    search: typeof req.query.search === "string" ? req.query.search.slice(0, 200) : "",
    sortColumn: sortColumn && INDEXABLE_TYPES.includes(sortColumn.type) ? sortColumn : null,
    order: req.query.order === "asc" ? "asc" : "desc",
    page,
    limit,
    departmentIds: departmentFilter(user, schema),
  });

  // resolve relation ids to display names, only for records the user may see
  const relationLabels = new Map<string, Map<string, string>>();
  for (const column of schema.columns) {
    if (column.type !== "relation" || !column.ref || !column.showInTable) continue;
    const ids = new Set(result.rows.flatMap((r) => fileUrls(r.data[column.name])));
    if (!ids.size) continue;
    const refSchema = await getSchema(column.ref);
    if (!refSchema || !can(user, refSchema, "view")) continue;

    const display = pickDisplayField(refSchema, column.displayField);
    const found = await getRecordsByIds(refSchema.tableName, [...ids], departmentFilter(user, refSchema));
    relationLabels.set(
      column.name,
      new Map(found.map((r) => [r._id, String((display === "_id" ? r._id : r.data[display]) || r._id)]))
    );
  }

  const visible = schema.columns.filter((c) => c.showInTable);
  const withDepartment = isAdmin(user) || allowedDepartments(user, schema).length > 1;
  const relationLabel = (labels: Map<string, string> | undefined, id: unknown) =>
    id ? (labels?.get(String(id)) ?? "—") : "";

  const data = result.rows.map((row) => {
    const out: Record<string, unknown> = { _id: row._id };
    for (const column of visible) {
      const key = column.label || column.name;
      const value = row.data[column.name];
      if (column.type === "richtext") out[key] = htmlToText(value, 120);
      else if (column.type === "relation") {
        const labels = relationLabels.get(column.name);
        out[key] = Array.isArray(value) ? value.map((id) => relationLabel(labels, id)) : relationLabel(labels, value);
      } else out[key] = value;
    }
    if (withDepartment) out._department = row.departmentName ?? "Unassigned";
    return out;
  });

  res.json({ data, total: result.total, totalIsEstimate: result.totalIsEstimate, page, limit });
}

/* ---------------- relation options ---------------- */

export async function optionsHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "view");
  const ids =
    typeof req.query.ids === "string" && req.query.ids
      ? [...new Set(req.query.ids.split(",").filter(Boolean))].slice(0, 200)
      : undefined;

  res.json(
    await getRecordOptions(schema.tableName, pickDisplayField(schema, String(req.query.displayField ?? "")), {
      search: typeof req.query.search === "string" ? req.query.search.slice(0, 200) : "",
      ids,
      limit: intParam(req.query.limit, 50, 1, 200),
      departmentIds: departmentFilter(user, schema),
    })
  );
}

/* ---------------- one record ---------------- */

export async function getHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "view");
  const record = await getRecord(schema.tableName, param(req, "id"), departmentFilter(user, schema));
  if (!record) throw new HttpError(404, "Record not found");
  res.json({ _id: record._id, ...record.data, _departmentId: record.departmentId });
}

export async function createHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "create");
  const payload = (req.body ?? {}) as Record<string, unknown>;

  const { values, errors } = coerceValues(schema, payload);
  throwIfErrors({ ...errors, ...checkRequired(schema, values) });
  const departmentId = resolveDepartment(user, schema, payload._departmentId, true) ?? null;
  throwIfErrors(await checkRelations(user, schema, values));

  const id = await withTransaction(async (client) => {
    const newId = await insertRecord(schema.tableName, values, departmentId, client);
    await audit(
      req,
      {
        action: "create",
        entity: "record",
        tableName: schema.tableName,
        recordId: newId,
        changes: {
          ...snapshot(values, "to"),
          ...(departmentId ? { _department: { to: departmentName(schema, departmentId) } } : {}),
        },
      },
      client
    );
    return newId;
  });

  res.json({ message: "Data inserted successfully", data: { acknowledged: true, insertedId: id } });
}

export async function updateHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "edit");
  const id = param(req, "id");
  const payload = (req.body ?? {}) as Record<string, unknown>;

  const { values, errors } = coerceValues(schema, payload);
  throwIfErrors(errors);
  const newDepartmentId = resolveDepartment(user, schema, payload._departmentId, false);

  const { before, after } = await withTransaction(async (client) => {
    const current = await lockRecord(schema.tableName, id, departmentFilter(user, schema), client);
    if (!current) throw new HttpError(404, "Record not found");

    const merged: RecordData = { ...current.data, ...values };
    throwIfErrors(checkRequired(schema, merged));
    throwIfErrors(await checkRelations(user, schema, values, current.data));

    await updateRecord(schema.tableName, id, values, { departmentIds: null, newDepartmentId }, client);

    const changes: Record<string, unknown> = diffRecord(current.data, merged);
    if (newDepartmentId !== undefined && newDepartmentId !== current.departmentId) {
      changes._department = {
        from: departmentName(schema, current.departmentId),
        to: departmentName(schema, newDepartmentId),
      };
    }
    if (Object.keys(changes).length) {
      await audit(req, { action: "update", entity: "record", tableName: schema.tableName, recordId: id, changes }, client);
    }
    return { before: current.data, after: merged };
  });

  // delete files that were removed from file/image fields
  const removed: string[] = [];
  for (const column of schema.columns) {
    if (!FILE_COLUMN_TYPES.includes(column.type) || !(column.name in values)) continue;
    const kept = new Set(fileUrls(after[column.name]));
    removed.push(...fileUrls(before[column.name]).filter((url) => !kept.has(url)));
  }
  await deleteUploads(removed);

  res.json({ message: "Updated successfully", result: { acknowledged: true, matchedCount: 1, modifiedCount: 1 } });
}

export async function deleteHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "delete");
  const id = param(req, "id");

  const deleted = await withTransaction(async (client) => {
    const record = await deleteRecord(schema.tableName, id, departmentFilter(user, schema), client);
    if (!record) throw new HttpError(404, "Record not found");
    await audit(
      req,
      {
        action: "delete",
        entity: "record",
        tableName: schema.tableName,
        recordId: id,
        changes: {
          ...snapshot(record.data, "from"),
          ...(record.departmentId ? { _department: { from: departmentName(schema, record.departmentId) } } : {}),
        },
      },
      client
    );
    return record;
  });

  await deleteUploads(
    schema.columns.filter((c) => FILE_COLUMN_TYPES.includes(c.type)).flatMap((c) => fileUrls(deleted.data[c.name]))
  );
  res.json({ message: "Deleted successfully", result: { acknowledged: true, deletedCount: 1 } });
}
