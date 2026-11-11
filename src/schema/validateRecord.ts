import { can, recordScope, isAdmin } from "../auth/access.js";
import { getRecordsByIds } from "../repo/recordRepo.js";
import { existingDepartmentIds, getUserOptionsByIds } from "../repo/userRepo.js";
import { UPLOAD_URL_PREFIX } from "../storage.js";
import type { Column, CurrentUser, RecordData, TableSchema } from "../types.js";
import { getSchema } from "./schemaRepo.js";

// Server-side validation of record values against the table's columns.

type Errors = Record<string, string>;

const MAX_LENGTH: Partial<Record<Column["type"], number>> = {
  text: 5_000,
  textarea: 50_000,
  richtext: 500_000,
};

const isEmpty = (value: unknown, column?: Column) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  // rich text with no visible text, e.g. "<p></p>"
  (column?.type === "richtext" && typeof value === "string" && !value.replace(/<[^>]*>|&nbsp;/g, "").trim());

const asFileUrl = (value: unknown): string | null => {
  const url = typeof value === "string" ? value : (value as { url?: unknown } | null)?.url;
  return typeof url === "string" && url.startsWith(UPLOAD_URL_PREFIX) && !url.includes("..") ? url : null;
};

// Convert one incoming value to its stored form. Throws a message on bad input.
function coerce(column: Column, value: unknown): unknown {
  if (value === undefined || value === null) return null;

  switch (column.type) {
    case "text":
    case "textarea":
    case "richtext": {
      if (typeof value === "number") value = String(value);
      if (typeof value !== "string") throw "must be text";
      const max = MAX_LENGTH[column.type]!;
      if (value.length > max) throw `is too long (max ${max.toLocaleString("en")} characters)`;
      return value;
    }
    case "number": {
      if (value === "") return null;
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
      if (!Number.isFinite(n)) throw "must be a number";
      return n;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      if (value === "") return null;
      throw "must be true or false";
    }
    case "date": {
      if (value === "") return null;
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) {
        throw "must be a date (YYYY-MM-DD)";
      }
      return value;
    }
    case "relation":
    case "user":
    case "department": {
      const what = column.type === "relation" ? "record" : column.type;
      if (column.multiple) {
        const list = Array.isArray(value) ? value : value === "" ? [] : [value];
        if (!list.every((v) => typeof v === "string" && v)) throw `must be a list of ${what} ids`;
        return [...new Set(list as string[])];
      }
      if (value === "") return null;
      if (typeof value !== "string") throw `must be a ${what} id`;
      return value;
    }
    case "autonumber": {
      // normally given by the server; a value can come from an import
      if (typeof value === "number") value = String(value);
      if (typeof value !== "string") throw "must be text";
      if (value.length > 100) throw "is too long";
      return value.trim() || null;
    }
    case "choice": {
      // matched to an option's exact label ignoring case/spaces; whether it
      // is an option at all is checked in checkChoices
      const canonical = (v: unknown) => {
        if (typeof v === "number") v = String(v);
        if (typeof v !== "string") throw "must be one of its options";
        const trimmed = v.trim();
        return column.options?.find((o) => o.label.toLowerCase() === trimmed.toLowerCase())?.label ?? trimmed;
      };
      if (column.multiple) {
        const list = Array.isArray(value) ? value : value === "" ? [] : [value];
        return [...new Set(list.map(canonical).filter(Boolean))];
      }
      const one = canonical(value);
      return one === "" ? null : one;
    }
    case "image":
    case "file": {
      if (value === "") return null;
      const url = asFileUrl(value);
      if (!url) throw "must be an uploaded file";
      return url;
    }
    case "images":
    case "files": {
      const list = Array.isArray(value) ? value : [value];
      const urls = list.map(asFileUrl);
      if (urls.some((u) => !u)) throw "must be uploaded files";
      return urls;
    }
  }
}

// Validate the fields present in `payload`. Unknown keys are ignored.
export function coerceValues(schema: TableSchema, payload: Record<string, unknown>) {
  const values: RecordData = {};
  const errors: Errors = {};
  for (const column of schema.columns) {
    if (!(column.name in payload)) continue;
    if (column.type === "formula") continue; // worked out by the server
    try {
      values[column.name] = coerce(column, payload[column.name]);
    } catch (message) {
      errors[column.name] = `${column.label || column.name} ${String(message)}`;
    }
  }
  return { values, errors };
}

// Choice values must be one of the column's options. Values the record
// already had are fine (an option removed later stays on old records until
// someone changes that field).
export function checkChoices(schema: TableSchema, values: RecordData, previous: RecordData = {}): Errors {
  const errors: Errors = {};
  for (const column of schema.columns) {
    if (column.type !== "choice" || !(column.name in values)) continue;
    const allowed = new Set([
      ...(column.options ?? []).map((o) => o.label),
      ...([] as unknown[]).concat(previous[column.name] ?? []).filter((v): v is string => typeof v === "string"),
    ]);
    const bad = ([] as unknown[]).concat(values[column.name] ?? []).find((v) => typeof v === "string" && !allowed.has(v));
    if (bad !== undefined) {
      const options = (column.options ?? []).map((o) => o.label);
      const list = options.length <= 8 ? `: ${options.join(", ")}` : "";
      errors[column.name] = `"${String(bad)}" is not an option for ${column.label || column.name}${list ? ` (choose${list})` : ""}`;
    }
  }
  return errors;
}

// Required fields must be filled in the final (merged) record.
export function checkRequired(schema: TableSchema, record: RecordData): Errors {
  const errors: Errors = {};
  for (const column of schema.columns) {
    if (column.required && isEmpty(record[column.name], column)) {
      errors[column.name] = `${column.label || column.name} is required`;
    }
  }
  return errors;
}

// Linked records must exist and be visible to the user. Ids that were already
// on the record before this change aren't re-checked (so an unrelated edit
// never fails because of an older link).
export async function checkRelations(
  user: CurrentUser,
  schema: TableSchema,
  values: RecordData,
  previous: RecordData = {}
): Promise<Errors> {
  const errors: Errors = {};

  for (const column of schema.columns) {
    if (!(column.name in values)) continue;
    if (column.type !== "user" && column.type !== "department" && (column.type !== "relation" || !column.ref)) continue;

    const before = new Set(
      ([] as unknown[]).concat(previous[column.name] ?? []).filter((v): v is string => typeof v === "string")
    );
    const ids = ([] as unknown[])
      .concat(values[column.name] ?? [])
      .filter((v): v is string => typeof v === "string" && !before.has(v));
    if (!ids.length) continue;

    const label = column.label || column.name;
    if (column.type === "user") {
      // newly chosen people must be existing, active accounts
      const found = await getUserOptionsByIds(ids);
      if (ids.some((id) => !found.get(id)?.isActive)) errors[column.name] = `${label}: user not found or deactivated`;
      continue;
    }
    if (column.type === "department") {
      if ((await existingDepartmentIds(ids)).length !== ids.length) errors[column.name] = `${label}: department not found`;
      continue;
    }
    const refSchema = await getSchema(column.ref!);
    if (!refSchema) {
      errors[column.name] = `${label}: the linked table no longer exists`;
      continue;
    }
    if (!isAdmin(user) && !can(user, refSchema, "view")) {
      errors[column.name] = `${label}: you don't have access to "${refSchema.tableName}"`;
      continue;
    }

    const found = await getRecordsByIds(refSchema.tableName, ids, recordScope(user, refSchema));
    if (found.length !== ids.length) errors[column.name] = `${label}: linked record not found`;
  }
  return errors;
}
