import type { Request } from "express";
import type pg from "pg";
import { can, recordScope } from "../auth/access.js";
import { dataTable } from "../db/dataTables.js";
import { query, quoteLiteral } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { audit, diffRecord, snapshot } from "../repo/auditRepo.js";
import { deleteRecord, insertRecord, lockRecord, updateRecord } from "../repo/recordRepo.js";
import { assignAutonumbers, autonumberColumns } from "../schema/autonumber.js";
import { withDefaults } from "../schema/defaults.js";
import { applyFormulas } from "../schema/formula.js";
import { refreshParents } from "../schema/rollups.js";
import { getAllSchemas } from "../schema/schemaRepo.js";
import { checkChoices, checkRelations, checkRequired, coerceValues } from "../schema/validateRecord.js";
import type { CurrentUser, RecordData, TableSchema } from "../types.js";

// Line items: records of another table edited inside their parent's form
// (an invoice's lines, a purchase order's items). The child table's link
// column to the parent is marked `inline`. The parent's create/update request
// carries them:
//
//   _children: { "<child table>": { create: [{...}], update: [{ _id, ...}], delete: ["<id>"] } }
//
// and they're saved in the parent's transaction. Errors come back per line as
// "<child table>.<create|update>.<index>.<column>", e.g. "invoice_lines.create.2.qty".

type ChildOps = { create?: Record<string, unknown>[]; update?: (Record<string, unknown> & { _id?: unknown })[]; delete?: unknown[] };

// What a preview save worked out: the record and its lines (in order).
export async function readBack(parent: TableSchema, id: string, client: pg.PoolClient) {
  const { rows } = await query<{ data: RecordData }>(`SELECT data FROM ${dataTable(parent.tableName)} WHERE _id = $1`, [id], client);
  const lines: Record<string, (RecordData & { _id: string })[]> = {};
  for (const { schema, link } of await inlineChildren(parent.tableName)) {
    const found = await query<{ _id: string; data: RecordData }>(
      `SELECT _id, data FROM ${dataTable(schema.tableName)} WHERE data -> ${quoteLiteral(link.name)} ?| $1::text[] ORDER BY created_at, _id`,
      [[id]],
      client
    );
    lines[schema.tableName] = found.rows.map((r) => ({ ...r.data, _id: r._id }));
  }
  return { data: rows[0]?.data ?? {}, lines };
}

// Lines go with their parent: deleting an invoice deletes its lines.
export async function deleteChildren(parent: string, parentIds: string[], client: pg.PoolClient) {
  if (!parentIds.length) return;
  for (const { schema, link } of await inlineChildren(parent)) {
    await query(
      `DELETE FROM ${dataTable(schema.tableName)} WHERE data -> ${quoteLiteral(link.name)} ?| $1::text[]`,
      [parentIds],
      client
    );
  }
}

// Tables edited inside `parent`'s form, with their link column.
export async function inlineChildren(parent: string) {
  return (await getAllSchemas()).flatMap((schema) =>
    schema.columns
      .filter((c) => c.type === "relation" && c.ref === parent && c.inline && !c.multiple)
      .map((link) => ({ schema, link }))
  );
}

const MAX_LINES = 500;

export async function saveChildren(
  req: Request,
  user: CurrentUser,
  parent: TableSchema,
  parentId: string,
  departmentId: string | null,
  raw: unknown,
  client: pg.PoolClient,
  // a preview (?preview=1) of unsaved lines: don't insist on required fields yet
  opts: { preview?: boolean } = {}
) {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "_children must be an object");
  const children = await inlineChildren(parent.tableName);
  const errors: Record<string, string> = {};
  const touched: { schema: TableSchema; rows: RecordData[] }[] = [];

  for (const [tableName, opsRaw] of Object.entries(raw as Record<string, ChildOps>)) {
    const child = children.find((c) => c.schema.tableName === tableName);
    if (!child) throw new HttpError(400, `"${tableName}" isn't edited inside ${parent.tableName}`);
    const { schema, link } = child;
    const ops = opsRaw ?? {};
    const count = (ops.create?.length ?? 0) + (ops.update?.length ?? 0) + (ops.delete?.length ?? 0);
    if (count > MAX_LINES) throw new HttpError(400, `At most ${MAX_LINES} lines at a time`);
    const need = (action: "create" | "edit" | "delete") => {
      if (!can(user, schema, action)) throw new HttpError(403, `You can't ${action === "create" ? "add" : action} ${tableName}`);
    };
    const scope = recordScope(user, schema);
    const rows: RecordData[] = [];
    const key = (op: "create" | "update", i: number, field: string) => `${tableName}.${op}.${i}.${field}`;
    const rowErrors = (op: "create" | "update", i: number, list: Record<string, string>) => {
      for (const [field, message] of Object.entries(list)) errors[key(op, i, field)] = message;
    };
    // the link is set by the server, never taken from the line
    const own = (payload: Record<string, unknown>) => {
      const copy = { ...payload };
      delete copy[link.name];
      delete copy._id;
      for (const c of autonumberColumns(schema)) delete copy[c.name];
      return copy;
    };
    const withoutLink = (values: RecordData) => {
      const copy = { ...values };
      delete copy[link.name];
      return copy;
    };

    // new lines
    const created: { i: number; values: RecordData }[] = [];
    for (const [i, line] of (ops.create ?? []).entries()) {
      need("create");
      const { values, errors: fieldErrors } = coerceValues(schema, withDefaults(schema, own(line ?? {}), user));
      values[link.name] = parentId;
      rowErrors("create", i, { ...fieldErrors, ...(opts.preview ? {} : checkRequired(schema, values)), ...checkChoices(schema, values, {}, user) });
      rowErrors("create", i, await checkRelations(user, schema, withoutLink(values)));
      created.push({ i, values });
    }

    // changed lines (must belong to this parent)
    const updated: { i: number; id: string; values: RecordData; before: RecordData }[] = [];
    for (const [i, line] of (ops.update ?? []).entries()) {
      need("edit");
      const id = typeof line?._id === "string" ? line._id : "";
      const current = id ? await lockRecord(schema.tableName, id, scope, client) : null;
      if (!current || current.data[link.name] !== parentId) {
        errors[key("update", i, "_id")] = "Line not found";
        continue;
      }
      const { values, errors: fieldErrors } = coerceValues(schema, own(line));
      const merged = { ...current.data, ...values };
      rowErrors("update", i, {
        ...fieldErrors,
        ...(opts.preview ? {} : checkRequired(schema, merged)),
        ...checkChoices(schema, values, current.data, user),
      });
      rowErrors("update", i, await checkRelations(user, schema, values, current.data));
      updated.push({ i, id, values, before: current.data });
    }

    // removed lines (must belong to this parent)
    const removing: string[] = [];
    for (const id of ops.delete ?? []) {
      need("delete");
      if (typeof id !== "string") continue;
      const current = await lockRecord(schema.tableName, id, scope, client);
      if (current && current.data[link.name] === parentId) removing.push(id);
    }

    if (Object.keys(errors).length) continue; // report everything at the end

    const ids: string[] = [];
    const createdValues = created.map((c) => c.values);
    await assignAutonumbers(schema, createdValues, client);
    for (const values of createdValues) {
      const id = await insertRecord(schema.tableName, values, departmentId, user._id, client);
      ids.push(id);
      rows.push(values);
      await audit(req, { action: "create", entity: "record", tableName: schema.tableName, recordId: id, changes: snapshot(values, "to") }, client);
    }
    for (const u of updated) {
      await updateRecord(schema.tableName, u.id, u.values, { scope }, client);
      ids.push(u.id);
      const after = { ...u.before, ...u.values };
      rows.push(u.before, after);
      const changes = diffRecord(u.before, after);
      if (Object.keys(changes).length) {
        await audit(req, { action: "update", entity: "record", tableName: schema.tableName, recordId: u.id, changes }, client);
      }
    }
    for (const id of removing) {
      const gone = await deleteRecord(schema.tableName, id, scope, client);
      if (!gone) continue;
      rows.push(gone.data);
      await audit(req, { action: "delete", entity: "record", tableName: schema.tableName, recordId: id, changes: snapshot(gone.data, "from") }, client);
    }
    await applyFormulas(schema, ids, client);
    touched.push({ schema, rows });
  }

  if (Object.keys(errors).length) {
    const first = Object.values(errors)[0];
    throw new HttpError(400, `Check the lines: ${first}`, errors);
  }
  // the parent's totals over its lines, and upwards
  for (const { schema, rows } of touched) await refreshParents(schema.tableName, rows, client);
}
