import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/http.js";
import { COLUMN_TYPES, type ChoiceOption, type Column, type ColumnType, type RollupConfig, type TableSchema } from "../types.js";

// Validation and defaults for table/column definitions.

export const FILE_COLUMN_TYPES: ColumnType[] = ["image", "images", "file", "files"];
export const RICH_TEXT_TYPES: ColumnType[] = ["richtext"];
// column types that can get a sort index
export const INDEXABLE_TYPES: ColumnType[] = ["text", "textarea", "number", "date", "boolean", "autonumber", "formula", "rollup"];

// What a column's values are: a formula's values are of its result type.
export const valueType = (column: Column): ColumnType =>
  column.type === "formula"
    ? (column.formula?.type ?? "text")
    : column.type === "rollup"
      ? (column.rollup?.type ?? "number")
      : column.type;
// column types that make a readable name for a record (relation labels)
const DISPLAYABLE_TYPES: ColumnType[] = ["text", "autonumber", "number", "date", "textarea"];

// a single choice sorts by its options' order (To do < Doing < Done)
export const isSortable = (column: Column) =>
  INDEXABLE_TYPES.includes(column.type) || (column.type === "choice" && !column.multiple);

// Colours for choice options (Mantine colour names). New options take the
// next unused one, so a list looks right without anyone picking colours.
export const CHOICE_COLORS = [
  "blue", "green", "orange", "red", "grape", "teal", "yellow", "pink", "indigo", "cyan", "lime", "violet", "gray",
] as const;
const MAX_OPTIONS = 100;

// Clean up a list of choice options: trimmed labels, no blanks or duplicates,
// a stable id and a colour for each.
export const normalizeOptions = (input: unknown): ChoiceOption[] => {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new HttpError(400, "options must be a list");
  const seen = new Set<string>();
  const used = new Set<string>();
  const options: ChoiceOption[] = [];
  for (const raw of input) {
    const item = (typeof raw === "string" ? { label: raw } : (raw ?? {})) as Partial<ChoiceOption>;
    const label = String(item.label ?? "").trim().slice(0, 100);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) throw new HttpError(400, `The option "${label}" is listed twice`);
    seen.add(key);
    const color = (CHOICE_COLORS as readonly string[]).includes(String(item.color)) ? String(item.color) : "";
    options.push({ id: item.id ? String(item.id).slice(0, 40) : randomUUID().slice(0, 8), label, color });
    if (color) used.add(color);
  }
  if (options.length > MAX_OPTIONS) throw new HttpError(400, `At most ${MAX_OPTIONS} options`);
  // fill in missing colours, preferring ones not used yet
  let next = 0;
  for (const option of options) {
    if (option.color) continue;
    const free = CHOICE_COLORS.find((c) => !used.has(c));
    option.color = free ?? CHOICE_COLORS[next++ % CHOICE_COLORS.length];
    used.add(option.color);
  }
  return options;
};

// Column types that can have a default value, and the special ones they take
export const DEFAULTABLE_TYPES: ColumnType[] = [
  "text", "textarea", "number", "boolean", "choice", "date", "user", "department",
];
export const TODAY = "today";
export const ME = "$me";
export const MINE = "$mine";

// Check a column's default value. Returns undefined for "no default".
export const normalizeDefault = (column: Column, raw: unknown): unknown => {
  if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && !raw.length)) return undefined;
  const fail = (message: string): never => {
    throw new HttpError(400, `Default for "${column.label || column.name}": ${message}`);
  };
  switch (column.type) {
    case "text":
    case "textarea":
      if (typeof raw !== "string" && typeof raw !== "number") fail("must be text");
      if (String(raw).length > 5_000) fail("is too long");
      return String(raw);
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? n : fail("must be a number");
    }
    case "boolean":
      return typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : fail("must be yes or no");
    case "date":
      // a fixed date is rarely what anyone wants; "today" covers the real need
      return raw === TODAY ? TODAY : fail('can only be "today"');
    case "user":
      return raw === ME ? ME : fail("can only be the person creating the record");
    case "department":
      return raw === MINE ? MINE : fail("can only be the creator's department");
    case "choice": {
      const pickOne = (v: unknown) =>
        column.options?.find((o) => o.label.toLowerCase() === String(v).trim().toLowerCase())?.label ??
        fail(`"${String(v)}" is not one of its options`);
      if (column.multiple) return [...new Set((Array.isArray(raw) ? raw : [raw]).map(pickOne))];
      return pickOne(Array.isArray(raw) ? raw[0] : raw);
    }
    default:
      return fail(`${column.type} columns can't have one`);
  }
};

// Types a "choice" column can be changed to or from (its values are plain text).
const CHOICE_CONVERTIBLE: ColumnType[] = ["text", "textarea"];

// column types whose values are ids (of records / users): their type is fixed
// once created, since existing values can't be converted
// (auto-numbers and formulas too: their values come from the server)
const ID_TYPES: ColumnType[] = ["relation", "user", "department", "autonumber", "formula", "rollup"];

const ROLLUP_FNS = ["count", "sum", "avg", "min", "max"];
// The shape of a roll-up; whether its tables and columns exist is checked by
// checkRollups() (schema/rollups.ts), which also works out its type.
const normalizeRollup = (raw: unknown): RollupConfig => {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const from = str(r.from);
  const via = str(r.via);
  const fn = str(r.fn) || "count";
  if (!from || !via) throw new HttpError(400, "Choose the linked records to total");
  if (!ROLLUP_FNS.includes(fn)) throw new HttpError(400, `Unknown calculation "${fn}"`);
  const field = str(r.field);
  if (fn !== "count" && !field) throw new HttpError(400, "Choose the field to total");
  const out: RollupConfig = { from, via, fn: fn as RollupConfig["fn"] };
  if (field && fn !== "count") out.field = field;
  const where = r.where as Record<string, unknown> | undefined;
  if (where && str(where.column)) {
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
    const w: NonNullable<RollupConfig["where"]> = { column: str(where.column) };
    if (list(where.in).length) w.in = list(where.in);
    if (list(where.notIn).length) w.notIn = list(where.notIn);
    if (w.in || w.notIn) out.where = w;
  }
  if (r.type === "number" || r.type === "date") out.type = r.type;
  return out;
};

const normalizeExpression = (raw: unknown) => {
  const expression = typeof raw === "string" ? raw.trim() : "";
  if (!expression) throw new HttpError(400, "Enter a formula");
  if (expression.length > 1_000) throw new HttpError(400, "The formula is too long (max 1,000 characters)");
  return expression;
};

const normalizePrefix = (raw: unknown) => {
  const prefix = typeof raw === "string" ? raw.trim() : "";
  if (prefix.length > 30) throw new HttpError(400, "The prefix is too long (max 30 characters)");
  return prefix;
};

// older spellings that may still arrive from clients or stored schemas
const TYPE_ALIASES: Record<string, ColumnType> = { richText: "richtext" };

const canonicalType = (type: unknown): ColumnType => {
  const value = typeof type === "string" ? (TYPE_ALIASES[type] ?? type) : "text";
  if (!(COLUMN_TYPES as readonly string[]).includes(value)) {
    throw new HttpError(400, `Invalid column type: ${String(type)}`);
  }
  return value as ColumnType;
};

const checkIndexable = (column: Column) => {
  if (column.indexed && !INDEXABLE_TYPES.includes(column.type)) {
    throw new HttpError(400, `Columns of type "${column.type}" can't be indexed`);
  }
};

export const validateTableName = (name: unknown): string => {
  if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "tableName is required");
  const trimmed = name.trim();
  if (Buffer.byteLength(trimmed) > 60) throw new HttpError(400, "Table name is too long");
  if (/[\0/\\]/.test(trimmed)) throw new HttpError(400, "Table name contains invalid characters");
  return trimmed;
};

// Fill in defaults for a column coming from a client or an older stored schema.
export const normalizeColumn = (input: Partial<Column> & Record<string, unknown>, { strict = true } = {}): Column => {
  if (!input.name || typeof input.name !== "string" || !input.name.trim()) {
    throw new HttpError(400, "Column name is required");
  }
  if (Buffer.byteLength(input.name) > 63 || input.name.includes("\0")) {
    throw new HttpError(400, "Column name is too long or contains invalid characters");
  }

  const fileConfig = (input.fileConfig ?? {}) as Partial<Column["fileConfig"]>;
  const column: Column = {
    _id: input._id ? String(input._id) : randomUUID(),
    name: input.name.trim(),
    type: strict ? canonicalType(input.type ?? "text") : (TYPE_ALIASES[String(input.type)] ?? input.type ?? "text") as ColumnType,
    showInTable: input.showInTable ?? true,
    required: Boolean(input.required),
    indexed: Boolean(input.indexed),
    ref: input.ref ? String(input.ref) : null,
    multiple: Boolean(input.multiple),
    fileConfig: {
      accept: Array.isArray(fileConfig.accept) ? fileConfig.accept.map(String) : [],
      maxSize: fileConfig.maxSize != null ? Number(fileConfig.maxSize) : 5,
      maxFiles: fileConfig.maxFiles != null ? Number(fileConfig.maxFiles) : 1,
    },
    uploadPath: typeof input.uploadPath === "string" ? input.uploadPath : "uploads",
  };
  if (typeof input.label === "string") column.label = input.label.trim().slice(0, 100);
  if (typeof input.displayField === "string") column.displayField = input.displayField;
  if (column.type === "relation" && !column.multiple && input.inline) column.inline = true;
  if (column.type === "rollup") {
    column.rollup = strict ? normalizeRollup(input.rollup) : (input.rollup as RollupConfig);
    column.required = false; // always worked out
  }
  if (column.type === "formula") {
    const config = (input.formula ?? {}) as { expression?: unknown; type?: unknown };
    // the result type is worked out by checkFormulas() once all columns are known
    column.formula = strict
      ? { expression: normalizeExpression(config.expression) }
      : { expression: String(config.expression ?? ""), type: config.type as NonNullable<Column["formula"]>["type"] };
    column.required = false; // always worked out
  }
  if (column.type === "autonumber") {
    const config = (input.autonumber ?? {}) as { prefix?: unknown };
    column.autonumber = { prefix: strict ? normalizePrefix(config.prefix) : String(config.prefix ?? "") };
    column.required = false; // always filled in
  }
  if (column.type === "choice") {
    column.options = strict ? normalizeOptions(input.options) : ((input.options as ChoiceOption[] | undefined) ?? []);
  }
  if (input.default !== undefined && input.default !== null) {
    if (!strict) column.default = input.default;
    else {
      const value = normalizeDefault(column, input.default);
      if (value !== undefined) column.default = value;
    }
  }

  if (strict) {
    if (column.type === "relation" && !column.ref) {
      throw new HttpError(400, "Relation columns need a linked table");
    }
    checkIndexable(column);
    if (column.type === "choice" && !column.options!.length) throw new HttpError(400, "Add at least one option");
  }
  return column;
};

// Fields of a column that can be changed via PUT /schema/:table/column/:name
const UPDATABLE = ["label", "type", "showInTable", "required", "indexed", "options", "default", "autonumber", "formula", "rollup", "inline"] as const;

export const applyColumnUpdate = (column: Column, payload: Record<string, unknown>): Column => {
  const updated: Column = { ...column };
  for (const key of UPDATABLE) {
    if (payload[key] === undefined) continue;
    if (key === "type") {
      const type = canonicalType(payload.type);
      if (type !== column.type && (ID_TYPES.includes(type) || ID_TYPES.includes(column.type))) {
        throw new HttpError(400, `A column can't be changed to or from "${ID_TYPES.includes(type) ? type : column.type}": delete it and add a new one`);
      }
      const choiceChange = type !== column.type && (type === "choice" || column.type === "choice");
      if (choiceChange && !CHOICE_CONVERTIBLE.includes(type === "choice" ? column.type : type)) {
        throw new HttpError(400, "Only Text columns can be changed to or from Choice");
      }
      updated.type = type;
      if (column.type === "choice" && type !== "choice") {
        delete updated.options;
        updated.multiple = false; // several picks become "A, B" text
      }
      if (type === "choice" && column.type !== "choice") {
        updated.multiple = false;
        updated.indexed = false; // choices sort by option order, without an index
      }
    } else if (key === "options" || key === "default") continue; // below, once the final type is known
    else if (key === "inline") {
      if (column.type === "relation" && !column.multiple) {
        if (payload.inline) updated.inline = true;
        else delete updated.inline;
      }
    } else if (key === "rollup") {
      if (column.type === "rollup") updated.rollup = normalizeRollup(payload.rollup);
    } else if (key === "formula") {
      // checked against the other columns by checkFormulas()
      if (column.type === "formula") {
        updated.formula = { expression: normalizeExpression((payload.formula as { expression?: unknown } | null)?.expression) };
      }
    } else if (key === "autonumber") {
      // a new prefix applies to new records only
      if (column.type === "autonumber") {
        updated.autonumber = { prefix: normalizePrefix((payload.autonumber as { prefix?: unknown } | null)?.prefix) };
      }
    }
    else if (key === "label") updated.label = String(payload.label).trim().slice(0, 100);
    else updated[key] = Boolean(payload[key]);
  }
  if (updated.type === "choice" && (payload.options !== undefined || column.type !== "choice")) {
    updated.options = normalizeOptions(payload.options);
    if (!updated.options.length) throw new HttpError(400, "Add at least one option");
  }

  // default: set or cleared explicitly; otherwise it follows renamed options,
  // and is dropped when the type changes or its option is removed
  if (payload.default !== undefined) {
    const value = normalizeDefault(updated, payload.default);
    if (value === undefined) delete updated.default;
    else updated.default = value;
  } else if (updated.default !== undefined) {
    if (updated.type !== column.type) delete updated.default;
    else if (updated.type === "choice") {
      const labelById = new Map((updated.options ?? []).map((o) => [o.id, o.label]));
      const follow = (label: unknown) => {
        const id = column.options?.find((o) => o.label === label)?.id;
        return id ? labelById.get(id) : undefined;
      };
      const next = Array.isArray(updated.default)
        ? updated.default.map(follow).filter((v): v is string => Boolean(v))
        : follow(updated.default);
      if (next === undefined || (Array.isArray(next) && !next.length)) delete updated.default;
      else updated.default = next;
    }
  }
  if (updated.type === "autonumber" || updated.type === "formula" || updated.type === "rollup") updated.required = false;
  checkIndexable(updated);
  return updated;
};

// Which field of a table's records to show when another table links to it.
export const pickDisplayField = (refSchema: TableSchema | null | undefined, displayField?: string): string => {
  const columns = refSchema?.columns ?? [];
  if (displayField && columns.some((c) => c.name === displayField)) return displayField;
  // a text column names a record best ("Anu Thomas", not "PAT-0001"); a
  // reference number when there's no text (invoices)
  return (
    columns.find((c) => c.showInTable && c.type === "text")?.name ||
    columns.find((c) => c.showInTable && DISPLAYABLE_TYPES.includes(c.type))?.name ||
    columns.find((c) => DISPLAYABLE_TYPES.includes(c.type))?.name ||
    "_id"
  );
};

export const columnByNameOrLabel = (schema: TableSchema, key: string) =>
  schema.columns.find((c) => c.name === key) ??
  schema.columns.find((c) => (c.label ?? "").toLowerCase() === key.toLowerCase()) ??
  schema.columns.find((c) => c.name.toLowerCase() === key.toLowerCase());
