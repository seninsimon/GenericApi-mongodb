import { quoteLiteral } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import type { Column, TableSchema } from "../types.js";

// Column filters for record lists and exports.
//
// Sent as ?filters=<JSON array> of { field, op, value?, value2? }.
// `field` is a column name, "_department" or "_createdBy". Which `op`s are
// allowed depends on the column type (see OPS_BY_KIND). For user columns and
// "_createdBy", the value "$me" stands for the user looking at the list, so a
// saved "Assigned to: me" link works for everyone.

export type FilterOp =
  | "contains"
  | "notContains"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "before"
  | "after"
  | "in"
  | "isTrue"
  | "isFalse"
  | "isEmpty"
  | "isNotEmpty";

export interface RecordFilter {
  field: string;
  op: FilterOp;
  value?: unknown;
  value2?: unknown;
}

type Kind = "text" | "number" | "date" | "boolean" | "relation" | "user" | "file" | "department" | "createdBy";

export const ME = "$me";

const OPS_BY_KIND: Record<Kind, FilterOp[]> = {
  text: ["contains", "notContains", "eq", "neq", "isEmpty", "isNotEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isEmpty", "isNotEmpty"],
  date: ["eq", "before", "after", "between", "isEmpty", "isNotEmpty"],
  boolean: ["isTrue", "isFalse", "isEmpty"],
  relation: ["in", "isEmpty", "isNotEmpty"],
  user: ["in", "isEmpty", "isNotEmpty"],
  file: ["isEmpty", "isNotEmpty"],
  department: ["in", "isEmpty"],
  createdBy: ["in", "isEmpty", "isNotEmpty"],
};

const kindOf = (column: Column): Kind => {
  switch (column.type) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "boolean":
      return "boolean";
    case "relation":
      return "relation";
    case "user":
      return "user";
    case "image":
    case "images":
    case "file":
    case "files":
      return "file";
    default:
      return "text";
  }
};

const MAX_FILTERS = 20;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isNumber = (v: unknown) => v !== "" && v !== null && Number.isFinite(Number(v));

// Parse and validate the ?filters= query value against the table's columns.
// `userId` replaces "$me" in user filters. Without it "$me" is kept as is
// (stored export jobs fill it in later for the user who started them).
export function parseFilters(raw: unknown, schema: TableSchema, userId: string | null = null): RecordFilter[] {
  if (raw === undefined || raw === "" || raw === null) return [];
  let list: unknown;
  try {
    list = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new HttpError(400, "filters must be a JSON array");
  }
  if (!Array.isArray(list)) throw new HttpError(400, "filters must be a JSON array");
  if (list.length > MAX_FILTERS) throw new HttpError(400, `At most ${MAX_FILTERS} filters`);

  return list.map((item) => {
    const f = item as RecordFilter;
    if (!f || typeof f.field !== "string" || typeof f.op !== "string") {
      throw new HttpError(400, "Each filter needs a field and an op");
    }
    const kind: Kind | null =
      f.field === "_department" ? "department" : f.field === "_createdBy" ? "createdBy" : (() => {
        const column = schema.columns.find((c) => c.name === f.field);
        return column ? kindOf(column) : null;
      })();
    if (!kind) throw new HttpError(400, `Unknown filter field "${f.field}"`);
    if (!OPS_BY_KIND[kind].includes(f.op)) throw new HttpError(400, `"${f.op}" can't be used on "${f.field}"`);

    // value checks per operator
    if (["contains", "notContains", "eq", "neq"].includes(f.op) && kind === "text" && typeof f.value !== "string") {
      throw new HttpError(400, `Filter on "${f.field}" needs a text value`);
    }
    if (kind === "number" && !["isEmpty", "isNotEmpty"].includes(f.op)) {
      if (!isNumber(f.value) || (f.op === "between" && !isNumber(f.value2))) {
        throw new HttpError(400, `Filter on "${f.field}" needs a number`);
      }
    }
    if (kind === "date" && !["isEmpty", "isNotEmpty"].includes(f.op)) {
      if (!isDate(f.value) || (f.op === "between" && !isDate(f.value2))) {
        throw new HttpError(400, `Filter on "${f.field}" needs a date (YYYY-MM-DD)`);
      }
    }
    if (f.op === "in" && (!Array.isArray(f.value) || !f.value.length || !f.value.every((v) => typeof v === "string"))) {
      throw new HttpError(400, `Filter on "${f.field}" needs a list of ids`);
    }
    const value =
      f.op === "in" && (kind === "user" || kind === "createdBy")
        ? (f.value as string[]).map((v) => (v === ME && userId ? userId : v))
        : f.value;
    return { field: f.field, op: f.op, value, value2: f.value2 };
  });
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

// SQL conditions for the filters (alias "t" = the data table). Values are
// always bound as parameters; only validated column names are inlined.
export function filterConditions(schema: TableSchema, filters: RecordFilter[], params: unknown[]): string[] {
  const p = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  return filters.map((f) => {
    if (f.field === "_department") {
      return f.op === "isEmpty" ? "t.department_id IS NULL" : `t.department_id = ANY(${p(f.value)}::text[])`;
    }
    if (f.field === "_createdBy") {
      if (f.op === "isEmpty") return "t.created_by IS NULL";
      if (f.op === "isNotEmpty") return "t.created_by IS NOT NULL";
      return `t.created_by = ANY(${p(f.value)}::text[])`;
    }

    const column = schema.columns.find((c) => c.name === f.field)!;
    const key = quoteLiteral(column.name);
    const json = `t.data -> ${key}`;
    const text = `(t.data ->> ${key})`;
    const empty = `(${json} IS NULL OR ${json} IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb))`;

    if (f.op === "isEmpty") return empty;
    if (f.op === "isNotEmpty") return `NOT ${empty}`;

    switch (kindOf(column)) {
      case "text": {
        if (f.op === "contains") return `${text} ILIKE ${p(`%${escapeLike(String(f.value))}%`)}`;
        if (f.op === "notContains") return `(${text} IS NULL OR ${text} NOT ILIKE ${p(`%${escapeLike(String(f.value))}%`)})`;
        if (f.op === "eq") return `lower(${text}) = lower(${p(f.value)})`;
        return `(${text} IS NULL OR lower(${text}) <> lower(${p(f.value)}))`; // neq
      }
      case "number": {
        const n = `erp_try_numeric(${text})`;
        const ops: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
        if (f.op === "between") return `${n} BETWEEN ${p(Number(f.value))} AND ${p(Number(f.value2))}`;
        return `${n} ${ops[f.op]} ${p(Number(f.value))}`;
      }
      case "date": {
        const day = `left(${text}, 10)`;
        if (f.op === "eq") return `${day} = ${p(f.value)}`;
        if (f.op === "before") return `${day} < ${p(f.value)}`;
        if (f.op === "after") return `${day} > ${p(f.value)}`;
        return `${day} BETWEEN ${p(f.value)} AND ${p(f.value2)}`; // between
      }
      case "boolean":
        return f.op === "isTrue" ? `${json} = 'true'::jsonb` : `${json} = 'false'::jsonb`;
      case "relation":
      case "user": {
        const ids = p(f.value);
        return `((jsonb_typeof(${json}) = 'array' AND ${json} ?| ${ids}::text[]) OR ${text} = ANY(${ids}::text[]))`;
      }
      default:
        return "TRUE";
    }
  });
}
