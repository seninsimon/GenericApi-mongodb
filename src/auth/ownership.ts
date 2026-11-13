import { dataTable } from "../db/dataTables.js";
import { query, quoteLiteral } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { pickDisplayField } from "../schema/columns.js";
import { peekSchema } from "../schema/schemaRepo.js";
import type { CurrentUser, RecordData, TableSchema } from "../types.js";
import { isAdmin, recordScope } from "./access.js";

// Whose record is it? The fields that make a record someone's:
//   - its person fields ("Claimed by", "Person", "Owner", "Doctor"), or
//   - when it has none, its links to a table where a person field says who
//     it is ("Employee" -> the People directory entry whose Login account is them).
// A time log's "Task" (assigned to whoever) doesn't decide whose time log it is.

type OwnerLink = { column: string; table: string; userColumns: string[] };
export type OwnerFields = { userColumns: string[]; links: OwnerLink[] };

export function ownerFields(schema: TableSchema): OwnerFields {
  const userColumns = schema.columns.filter((c) => c.type === "user").map((c) => c.name);
  if (userColumns.length) return { userColumns, links: [] };
  const links = schema.columns
    .filter((c) => c.type === "relation" && c.ref)
    .map((c) => ({ column: c.name, table: c.ref!, userColumns: (peekSchema(c.ref!)?.columns ?? []).filter((u) => u.type === "user").map((u) => u.name) }))
    .filter((l) => l.userColumns.length > 0);
  return { userColumns: [], links };
}

const ids = (v: unknown) => ([] as unknown[]).concat(v ?? []).filter((x): x is string => typeof x === "string" && x.length > 0);

// The records of a linked table that are this person (normally one: their
// People directory entry), with their names.
export async function selfRecords(link: OwnerLink, userId: string): Promise<{ _id: string; label: string }[]> {
  const target = peekSchema(link.table);
  if (!target) return [];
  const display = pickDisplayField(target);
  const where = link.userColumns.map((u) => `t.data -> ${quoteLiteral(u)} @> to_jsonb($1::text)`).join(" OR ");
  try {
    const { rows } = await query<{ _id: string; data: RecordData }>(
      `SELECT t._id, t.data FROM ${dataTable(link.table)} t WHERE ${where} ORDER BY t.created_at LIMIT 5`,
      [userId]
    );
    return rows.map((r) => ({ _id: r._id, label: String((display === "_id" ? r._id : r.data[display]) || r._id) }));
  } catch {
    return [];
  }
}

// Is this record this person's (through its owner fields)?
export async function isMine(schema: TableSchema, data: RecordData, userId: string): Promise<boolean> {
  const fields = ownerFields(schema);
  if (fields.userColumns.some((c) => ids(data[c]).includes(userId))) return true;
  for (const link of fields.links) {
    const linked = ids(data[link.column]);
    if (!linked.length) continue;
    if ((await selfRecords(link, userId)).some((r) => linked.includes(r._id))) return true;
  }
  return false;
}

const singular = (schema: TableSchema) => schema.tableName.replace(/_/g, " ").replace(/s$/, "");

// For someone who may only touch their own records in this table: the record
// must be theirs. Empty owner fields are filled in with them (or their People
// directory entry); pointing one at someone else is refused. Only changed
// values are checked, so a record a manager set up can still be edited.
// `before`: the saved record (edits), or null (new).
export async function keepItYours(schema: TableSchema, values: RecordData, before: RecordData | null, user: CurrentUser) {
  if (isAdmin(user) || !recordScope(user, schema).owner) return;
  const fields = ownerFields(schema);
  const names = [...fields.userColumns, ...fields.links.map((l) => l.column)];
  if (!names.length) return;
  const changed = names.filter((n) => n in values && JSON.stringify(values[n] ?? null) !== JSON.stringify(before?.[n] ?? null));
  if (before && !changed.length) return;

  const columnOf = (n: string) => schema.columns.find((c) => c.name === n)!;
  const errors: Record<string, string> = {};
  const merged = { ...(before ?? {}), ...values };
  const isEmpty = (n: string) => !ids(merged[n]).length;

  // new: fill in the empty owner fields with them
  if (!before) {
    for (const n of fields.userColumns) if (isEmpty(n)) values[n] = columnOf(n).multiple ? [user._id] : user._id;
    for (const link of fields.links) {
      if (!isEmpty(link.column)) continue;
      const self = await selfRecords(link, user._id);
      if (self.length) values[link.column] = columnOf(link.column).multiple ? [self[0]._id] : self[0]._id;
      else if (columnOf(link.column).required) {
        errors[link.column] = notListedMessage(link);
      }
    }
    Object.assign(merged, values);
  }
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors).join("; "), errors);

  // and it has to be theirs (pointing a field at someone else is refused)
  for (const n of fields.userColumns) {
    const picked = ids(merged[n]);
    if (picked.length && picked.some((id) => id !== user._id)) {
      errors[n] = `You can only add your own ${singular(schema)}s: ${columnOf(n).label || n} has to be you`;
    }
  }
  for (const link of fields.links) {
    const picked = ids(merged[link.column]);
    if (!picked.length) continue;
    const self = new Set((await selfRecords(link, user._id)).map((r) => r._id));
    if (picked.some((id) => !self.has(id))) {
      errors[link.column] = `You can only add your own ${singular(schema)}s: ${columnOf(link.column).label || link.column} has to be you`;
    }
  }
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors).join("; "), errors);
}

// "You're not in the People directory yet": when there's no entry for them.
export const notListedMessage = (link: OwnerLink) => {
  const target = peekSchema(link.table);
  const where = target?.blueprintKey === "people.employees" ? "the People directory" : `"${link.table.replace(/_/g, " ")}"`;
  return `You're not in ${where} yet, so this can't be linked to you. Ask HR or an admin to add you there (with your login).`;
};

// What the form shows for these fields: locked to the person ("You").
export async function ownFieldsFor(schema: TableSchema, user: CurrentUser) {
  if (isAdmin(user) || !recordScope(user, schema).owner) return [];
  const fields = ownerFields(schema);
  const out: { column: string; value: string | null; label: string; missing?: string }[] = [];
  for (const n of fields.userColumns) out.push({ column: n, value: user._id, label: user.fullName || user.username });
  for (const link of fields.links) {
    const [self] = await selfRecords(link, user._id);
    out.push(self ? { column: link.column, value: self._id, label: self.label } : { column: link.column, value: null, label: "", missing: notListedMessage(link) });
  }
  return out;
}

// Linking to your own entry needs no access to its table (an HR app user who
// can't open the People directory can still ask for their own leave).
export async function ownLinkIds(schema: TableSchema, column: string, user: CurrentUser): Promise<Set<string>> {
  const link = ownerFields(schema).links.find((l) => l.column === column);
  return new Set(link ? (await selfRecords(link, user._id)).map((r) => r._id) : []);
}

// Approval steps aren't for your own records: "You can't approve your own leave request".
export async function checkNotApprovingOwn(
  schema: TableSchema,
  values: RecordData,
  before: RecordData,
  user: CurrentUser
) {
  if (isAdmin(user)) return;
  for (const column of schema.columns) {
    if (column.type !== "choice" || !(column.name in values) || !column.options?.some((o) => o.roles?.length)) continue;
    const was = new Set(([] as unknown[]).concat(before[column.name] ?? []));
    const picked = ([] as unknown[]).concat(values[column.name] ?? []).filter((v) => !was.has(v));
    const approval = column.options.find((o) => o.roles?.length && picked.includes(o.label));
    if (!approval) continue;
    if (await isMine(schema, { ...before, ...values }, user._id)) {
      const message = `You can't approve your own ${singular(schema)}: someone else with Manager access has to set ${column.label || column.name} to "${approval.label}"`;
      throw new HttpError(400, message, { [column.name]: message });
    }
  }
}
