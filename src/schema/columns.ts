import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/http.js";
import { COLUMN_TYPES, type ChoiceOption, type Column, type ColumnType, type TableSchema } from "../types.js";

// Validation and defaults for table/column definitions.

export const FILE_COLUMN_TYPES: ColumnType[] = ["image", "images", "file", "files"];
export const RICH_TEXT_TYPES: ColumnType[] = ["richtext"];
// column types that can get a sort index
export const INDEXABLE_TYPES: ColumnType[] = ["text", "textarea", "number", "date", "boolean"];
// column types that make a readable name for a record (relation labels)
const DISPLAYABLE_TYPES: ColumnType[] = ["text", "number", "date", "textarea"];

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

// Types a "choice" column can be changed to or from (its values are plain text).
const CHOICE_CONVERTIBLE: ColumnType[] = ["text", "textarea"];

// column types whose values are ids (of records / users): their type is fixed
// once created, since existing values can't be converted
const ID_TYPES: ColumnType[] = ["relation", "user", "department"];

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
  if (column.type === "choice") {
    column.options = strict ? normalizeOptions(input.options) : ((input.options as ChoiceOption[] | undefined) ?? []);
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
const UPDATABLE = ["label", "type", "showInTable", "required", "indexed", "options"] as const;

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
    } else if (key === "options") continue; // below, once the final type is known
    else if (key === "label") updated.label = String(payload.label).trim().slice(0, 100);
    else updated[key] = Boolean(payload[key]);
  }
  if (updated.type === "choice" && (payload.options !== undefined || column.type !== "choice")) {
    updated.options = normalizeOptions(payload.options);
    if (!updated.options.length) throw new HttpError(400, "Add at least one option");
  }
  checkIndexable(updated);
  return updated;
};

// Which field of a table's records to show when another table links to it.
export const pickDisplayField = (refSchema: TableSchema | null | undefined, displayField?: string): string => {
  const columns = refSchema?.columns ?? [];
  if (displayField && columns.some((c) => c.name === displayField)) return displayField;
  return (
    columns.find((c) => c.showInTable && DISPLAYABLE_TYPES.includes(c.type))?.name ||
    columns.find((c) => DISPLAYABLE_TYPES.includes(c.type))?.name ||
    "_id"
  );
};

export const columnByNameOrLabel = (schema: TableSchema, key: string) =>
  schema.columns.find((c) => c.name === key) ??
  schema.columns.find((c) => (c.label ?? "").toLowerCase() === key.toLowerCase()) ??
  schema.columns.find((c) => c.name.toLowerCase() === key.toLowerCase());
