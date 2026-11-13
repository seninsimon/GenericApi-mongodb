import { quoteLiteral } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import type { Column, TableSchema } from "../types.js";
import { ME, MINE, valueType } from "./columns.js";

// Column filters for record lists and exports.
//
// Sent as ?filters=<JSON array> of { field, op, value?, value2? }.
// `field` is a column name, "_department" (who can see the record) or
// "_createdBy". Which `op`s are allowed depends on the column type (see
// OPS_BY_KIND). Two values stand for the person looking at the list, so one
// saved link works for everyone:
//   "$me"   in user columns and "_createdBy": that user
//   "$mine" in department columns: that user's departments

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
  | "notIn"
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

type Kind =
  | "text"
  | "number"
  | "date"
  | "boolean"
  | "relation"
  | "user"
  | "departmentColumn"
  | "choice"
  | "file"
  | "department"
  | "createdBy";

export { ME, MINE };

// who is looking at the list (for "$me" / "$mine")
type Viewer = { _id: string; departments: { _id: string }[] } | null;

const OPS_BY_KIND: Record<Kind, FilterOp[]> = {
  text: ["contains", "notContains", "eq", "neq", "isEmpty", "isNotEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isEmpty", "isNotEmpty"],
  date: ["eq", "before", "after", "between", "isEmpty", "isNotEmpty"],
  boolean: ["isTrue", "isFalse", "isEmpty"],
  relation: ["in", "isEmpty", "isNotEmpty"],
  user: ["in", "isEmpty", "isNotEmpty"],
  departmentColumn: ["in", "isEmpty", "isNotEmpty"],
  choice: ["in", "notIn", "isEmpty", "isNotEmpty"],
  file: ["isEmpty", "isNotEmpty"],
  department: ["in", "isEmpty"],
  createdBy: ["in", "isEmpty", "isNotEmpty"],
};

const kindOf = (column: Column): Kind => {
  // a formula filters like its result: number, date, yes/no or text
  switch (valueType(column)) {
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
    case "department":
      return "departmentColumn";
    case "choice":
      return "choice";
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
// "$today" stands for the current date, so a saved "Overdue" view keeps working
export const TODAY_TOKEN = "$today";
const isDate = (v: unknown): v is string => typeof v === "string" && (/^\d{4}-\d{2}-\d{2}$/.test(v) || v === TODAY_TOKEN);
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dateValue = (v: unknown) => (v === TODAY_TOKEN ? todayIso() : v);
const isNumber = (v: unknown) => v !== "" && v !== null && Number.isFinite(Number(v));

// Parse and validate the ?filters= query value against the table's columns.
// `viewer` fills in "$me" / "$mine". Without it they're kept as they are
// (stored export jobs fill them in later for the user who started them).
export function parseFilters(raw: unknown, schema: TableSchema, viewer: Viewer = null): RecordFilter[] {
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
    if (
      (f.op === "in" || f.op === "notIn") &&
      (!Array.isArray(f.value) || !f.value.length || !f.value.every((v) => typeof v === "string"))
    ) {
      throw new HttpError(400, `Filter on "${f.field}" needs a list of values`);
    }
    let value = f.value;
    if (f.op === "in" && viewer) {
      const list = f.value as string[];
      if (kind === "user" || kind === "createdBy") value = list.map((v) => (v === ME ? viewer._id : v));
      if (kind === "departmentColumn") value = list.flatMap((v) => (v === MINE ? viewer.departments.map((d) => d._id) : [v]));
    }
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
      if (f.op === "isEmpty") return "t.department_id IS NULL";
      const ids = `${p(f.value)}::text[]`;
      // visible to any of them: as the first department or a shared one
      return `(t.department_id = ANY(${ids}) OR t.shared_department_ids && ${ids})`;
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
        if (f.op === "eq") return `${day} = ${p(dateValue(f.value))}`;
        if (f.op === "before") return `${day} < ${p(dateValue(f.value))}`;
        if (f.op === "after") return `${day} > ${p(dateValue(f.value))}`;
        return `${day} BETWEEN ${p(dateValue(f.value))} AND ${p(dateValue(f.value2))}`; // between
      }
      case "boolean":
        return f.op === "isTrue" ? `${json} = 'true'::jsonb` : `${json} = 'false'::jsonb`;
      case "relation":
      case "user":
      case "departmentColumn":
      case "choice": {
        // `?|` matches a single id/label or one inside a list (and uses the
        // link columns' GIN index)
        const match = `${json} ?| ${p(f.value)}::text[]`;
        // "is not": also records with no value
        return f.op === "notIn" ? `NOT COALESCE(${match}, FALSE)` : match;
      }
      default:
        return "TRUE";
    }
  });
}
