import type { Request, Response } from "express";
import { ALL_RECORDS, allowedDepartments, can, isAdmin, recordScope } from "../auth/access.js";
import { withTransaction } from "../db/pool.js";
import { HttpError, intParam, param, toIdList } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit, diffRecord, snapshot } from "../repo/auditRepo.js";
import { departmentLabel, departmentNames, getUserOptionsByIds, userLabel } from "../repo/userRepo.js";
import {
  countUnassigned,
  deleteRecord,
  getRecord,
  getRecordOptions,
  getRecordsByIds,
  insertRecord,
  listRecords,
  lockRecord,
  updateRecord,
  type ListOptions,
} from "../repo/recordRepo.js";
import { parseFilters } from "../schema/filters.js";
import { columnByNameOrLabel, FILE_COLUMN_TYPES, isSortable, pickDisplayField } from "../schema/columns.js";
import { getSchema } from "../schema/schemaRepo.js";
import { assignAutonumbers, autonumberColumns } from "../schema/autonumber.js";
import { withDefaults } from "../schema/defaults.js";
import { applyFormulas } from "../schema/formula.js";
import { refreshParents } from "../schema/rollups.js";
import { afterSave } from "../schema/automations.js";
import { deleteChildren, readBack, saveChildren } from "./lineItems.js";

// ?preview=1 on create/update: do the whole save, read back what the server
// worked out (formulas, totals, line amounts), then roll it all back. The
// form shows these values as you type, from the same code as a real save.
class PreviewDone extends Error {
  constructor(readonly result: Awaited<ReturnType<typeof readBack>>) {
    super("preview");
  }
}
const isPreview = (req: Request) => req.query.preview === "1";
async function previewOrSave<T>(req: Request, res: Response, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PreviewDone) {
      res.json({ preview: true, ...error.result });
      return null;
    }
    throw error;
  }
}
import { checkChoices, checkRelations, checkRequired, coerceValues } from "../schema/validateRecord.js";
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

  const page = intParam(req.query.page, 1, 1, 1_000_000);
  const limit = intParam(req.query.limit, 10, 1, 500);

  const result = await listRecords(schema, {
    search: typeof req.query.search === "string" ? req.query.search.slice(0, 200) : "",
    filters: parseFilters(req.query.filters, schema, user),
    sort: resolveSort(schema, req.query.sort),
    order: req.query.order === "asc" ? "asc" : "desc",
    page,
    limit,
    scope: recordScope(user, schema),
  });

  // ?raw=1: stored values (ids, not names), e.g. for editing line items
  if (req.query.raw === "1") {
    res.json({
      data: result.rows.map((row) => ({ ...row.data, _id: row._id, _createdAt: row.createdAt })),
      total: result.total,
      totalIsEstimate: result.totalIsEstimate,
      page,
      limit,
    });
    return;
  }

  // resolve relation ids to display names, only for records the user may see
  const relationLabels = new Map<string, Map<string, string>>();
  for (const column of schema.columns) {
    if (column.type !== "relation" || !column.ref) continue;
    const ids = new Set(result.rows.flatMap((r) => fileUrls(r.data[column.name])));
    if (!ids.size) continue;
    const refSchema = await getSchema(column.ref);
    if (!refSchema || !can(user, refSchema, "view")) continue;

    const display = pickDisplayField(refSchema, column.displayField);
    const found = await getRecordsByIds(refSchema.tableName, [...ids], recordScope(user, refSchema));
    relationLabels.set(
      column.name,
      new Map(found.map((r) => [r._id, String((display === "_id" ? r._id : r.data[display]) || r._id)]))
    );
  }

  // names for "User" columns and "Created by"
  const userColumns = schema.columns.filter((c) => c.type === "user");
  const people = await getUserOptionsByIds([
    ...result.rows.map((r) => r.createdBy ?? ""),
    ...result.rows.flatMap((r) => userColumns.flatMap((c) => fileUrls(r.data[c.name]))),
  ]);

  const departments = schema.columns.some((c) => c.type === "department") ? await departmentNames() : new Map();

  // "Visible to" only matters when the table is shared with several
  // departments (with one, every record is in it), and only to people who can
  // see more than one of them. Admins also see it while some records are
  // "admins only" (e.g. after their department was deleted), so they can spot them.
  const withDepartment =
    (schema.departments.length > 1 && (isAdmin(user) || allowedDepartments(user, schema).length > 1)) ||
    (isAdmin(user) && (await countUnassigned(schema.tableName)) > 0);
  const relationLabel = (labels: Map<string, string> | undefined, id: unknown) =>
    id ? (labels?.get(String(id)) ?? "—") : "";

  // Rows are keyed by column NAME (all columns; showInTable only sets the
  // default visibility in the UI). Relations come back as display names, rich
  // text as a plain-text preview.
  const data = result.rows.map((row) => {
    const out: Record<string, unknown> = {
      _id: row._id,
      _createdAt: row.createdAt,
      _updatedAt: row.updatedAt,
      _createdBy: userLabel(people, row.createdBy) || null,
      _createdById: row.createdBy ?? null,
    };
    for (const column of schema.columns) {
      const value = row.data[column.name];
      if (column.type === "richtext") out[column.name] = htmlToText(value, 160);
      else if (column.type === "department") {
        out[column.name] = Array.isArray(value)
          ? value.map((id) => departmentLabel(departments, id))
          : departmentLabel(departments, value) || null;
      } else if (column.type === "user") {
        out[column.name] = Array.isArray(value)
          ? value.map((id) => userLabel(people, id))
          : userLabel(people, value) || null;
      }
      else if (column.type === "relation") {
        const labels = relationLabels.get(column.name);
        out[column.name] = Array.isArray(value)
          ? value.map((id) => relationLabel(labels, id))
          : relationLabel(labels, value);
      } else out[column.name] = value ?? null;
    }
    if (withDepartment) {
      out._department = row.departmentName ?? "Admins only";
      out._departmentId = row.departmentId;
    }
    return out;
  });

  res.json({ data, total: result.total, totalIsEstimate: result.totalIsEstimate, page, limit });
}

// ?sort= column name (or label), or _createdAt / _updatedAt
function resolveSort(schema: TableSchema, raw: unknown): ListOptions["sort"] {
  if (raw === "_createdAt" || raw === "_id" || raw === "createdAt") return "_createdAt";
  if (raw === "_updatedAt") return "_updatedAt";
  if (typeof raw !== "string" || !raw) return null;
  const column = columnByNameOrLabel(schema, raw);
  return column && isSortable(column) ? column : null;
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
      scope: recordScope(user, schema),
    })
  );
}

/* ---------------- one record ---------------- */

export async function getHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "view");
  const record = await getRecord(schema.tableName, param(req, "id"), recordScope(user, schema));
  if (!record) throw new HttpError(404, "Record not found");
  const creator = record.createdBy ? await getUserOptionsByIds([record.createdBy]) : new Map();
  res.json({
    _id: record._id,
    ...record.data,
    _departmentId: record.departmentId,
    _departmentName: record.departmentName,
    _createdBy: userLabel(creator, record.createdBy) || null,
    _createdById: record.createdBy ?? null,
    _createdAt: record.createdAt,
    _updatedAt: record.updatedAt,
  });
}

// POST /table/:collection/bulk-delete { ids: string[] } (max 500)
export async function bulkDeleteHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "delete");
  const ids = toIdList(req.body?.ids);
  if (!ids.length) throw new HttpError(400, "Select at least one record");
  if (ids.length > 500) throw new HttpError(400, "At most 500 records at a time");

  const deleted = await withTransaction(async (client) => {
    const removed = [];
    for (const id of ids) {
      const record = await deleteRecord(schema.tableName, id, recordScope(user, schema), client);
      if (!record) continue;
      removed.push(record);
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
    }
    await deleteChildren(schema.tableName, removed.map((r) => r._id), client); // their line items
    // totals in the records they linked to
    await refreshParents(schema.tableName, removed.map((r) => r.data), client);
    return removed;
  });

  await deleteUploads(
    deleted.flatMap((r) =>
      schema.columns.filter((c) => FILE_COLUMN_TYPES.includes(c.type)).flatMap((c) => fileUrls(r.data[c.name]))
    )
  );
  res.json({ message: `${deleted.length} record(s) deleted`, deleted: deleted.length, notFound: ids.length - deleted.length });
}

export async function createHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "create");
  const payload = withDefaults(schema, (req.body ?? {}) as Record<string, unknown>, user);
  const preview = isPreview(req);

  const { values, errors } = coerceValues(schema, payload);
  throwIfErrors({ ...errors, ...(preview ? {} : checkRequired(schema, values)), ...checkChoices(schema, values, {}, user) });
  const departmentId = preview
    ? (() => {
        try {
          return resolveDepartment(user, schema, payload._departmentId, true) ?? null;
        } catch {
          return null; // not chosen yet
        }
      })()
    : (resolveDepartment(user, schema, payload._departmentId, true) ?? null);
  throwIfErrors(await checkRelations(user, schema, values));

  const id = await previewOrSave(req, res, () => withTransaction(async (client) => {
    await assignAutonumbers(schema, [values], client);
    const newId = await insertRecord(schema.tableName, values, departmentId, user._id, client);
    await applyFormulas(schema, [newId], client);
    // its line items (an invoice's lines), then totals over them
    await saveChildren(req, user, schema, newId, departmentId, payload._children, client, { preview });
    if (preview) throw new PreviewDone(await readBack(schema, newId, client));
    await refreshParents(schema.tableName, [values], client); // totals in the records it links to
    // "assigned you" notifications, and the table's automations
    await afterSave(schema, newId, null, values, user._id, user, client);
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
  }));
  if (id === null) return; // a preview: already answered

  res.json({ message: "Data inserted successfully", data: { acknowledged: true, insertedId: id } });
}

export async function updateHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schema = await loadTable(req, "edit");
  const id = param(req, "id");
  const payload = { ...((req.body ?? {}) as Record<string, unknown>) };
  // auto-numbers are given once, when the record is created
  for (const column of autonumberColumns(schema)) delete payload[column.name];

  const { values, errors } = coerceValues(schema, payload);
  throwIfErrors(errors);
  const newDepartmentId = resolveDepartment(user, schema, payload._departmentId, false);
  const preview = isPreview(req);

  const saved = await previewOrSave(req, res, () => withTransaction(async (client) => {
    const current = await lockRecord(schema.tableName, id, recordScope(user, schema), client);
    if (!current) throw new HttpError(404, "Record not found");

    const merged: RecordData = { ...current.data, ...values };
    throwIfErrors({ ...(preview ? {} : checkRequired(schema, merged)), ...checkChoices(schema, values, current.data, user) });
    throwIfErrors(await checkRelations(user, schema, values, current.data));

    await updateRecord(schema.tableName, id, values, { scope: ALL_RECORDS, newDepartmentId }, client);
    await applyFormulas(schema, [id], client);
    const departmentId = newDepartmentId !== undefined ? newDepartmentId : current.departmentId;
    await saveChildren(req, user, schema, id, departmentId, payload._children, client, { preview });
    if (preview) throw new PreviewDone(await readBack(schema, id, client));
    // totals in the records it links to: before (it may have moved) and after
    await refreshParents(schema.tableName, [current.data, merged], client);
    // "assigned you" notifications, and the table's automations
    await afterSave(schema, id, current.data, merged, current.createdBy ?? null, user, client);

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
  }));
  if (saved === null) return; // a preview: already answered
  const { before, after } = saved;

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
    const record = await deleteRecord(schema.tableName, id, recordScope(user, schema), client);
    if (!record) throw new HttpError(404, "Record not found");
    await deleteChildren(schema.tableName, [id], client); // its line items go with it
    await refreshParents(schema.tableName, [record.data], client);
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
