import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/http.js";
import { COLUMN_TYPES, type Column, type ColumnType, type TableSchema } from "../types.js";

// Validation and defaults for table/column definitions.

export const FILE_COLUMN_TYPES: ColumnType[] = ["image", "images", "file", "files"];
export const RICH_TEXT_TYPES: ColumnType[] = ["richtext"];
// column types that can get a sort index
export const INDEXABLE_TYPES: ColumnType[] = ["text", "textarea", "number", "date", "boolean"];
// column types that make a readable name for a record (relation labels)
const DISPLAYABLE_TYPES: ColumnType[] = ["text", "number", "date", "textarea"];

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

  if (strict) {
    if (column.type === "relation" && !column.ref) {
      throw new HttpError(400, "Relation columns need a linked table");
    }
    checkIndexable(column);
  }
  return column;
};

// Fields of a column that can be changed via PUT /schema/:table/column/:name
const UPDATABLE = ["label", "type", "showInTable", "required", "indexed"] as const;

export const applyColumnUpdate = (column: Column, payload: Record<string, unknown>): Column => {
  const updated: Column = { ...column };
  for (const key of UPDATABLE) {
    if (payload[key] === undefined) continue;
    if (key === "type") updated.type = canonicalType(payload.type);
    else if (key === "label") updated.label = String(payload.label).trim().slice(0, 100);
    else updated[key] = Boolean(payload[key]);
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
