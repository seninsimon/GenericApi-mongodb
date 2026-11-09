import { randomUUID } from "crypto";

// Validation and defaults for table schema definitions.

export const COLUMN_TYPES = [
  "text",
  "number",
  "date",
  "boolean",
  "relation",
  "image",
  "images",
  "file",
  "files",
  "richtext",
  "textarea",
];

export const FILE_COLUMN_TYPES = ["image", "images", "file", "files"];

export class ValidationError extends Error {}

// older spellings that may still arrive from clients or old schemas
const TYPE_ALIASES = { richText: "richtext" };

const canonicalType = (type) => TYPE_ALIASES[type] ?? type;

const assertType = (type) => {
  if (!COLUMN_TYPES.includes(type)) {
    throw new ValidationError(`Invalid column type: ${type}`);
  }
};

export const normalizeColumn = (column = {}) => {
  if (!column.name || typeof column.name !== "string") {
    throw new ValidationError("Column name is required");
  }

  const type = canonicalType(column.type ?? "text");
  assertType(type);

  const fileConfig = column.fileConfig ?? {};

  const normalized = {
    _id: column._id ? String(column._id) : randomUUID(),
    name: column.name,
    type,
    showInTable: column.showInTable ?? true,
    ref: column.ref ?? null,
    multiple: column.multiple ?? false,
    fileConfig: {
      accept: Array.isArray(fileConfig.accept) ? fileConfig.accept.map(String) : [],
      maxSize: fileConfig.maxSize != null ? Number(fileConfig.maxSize) : 5,
      maxFiles: fileConfig.maxFiles != null ? Number(fileConfig.maxFiles) : 1,
    },
    uploadPath: column.uploadPath ?? "uploads",
  };

  if (column.label !== undefined) normalized.label = column.label;
  if (column.displayField !== undefined) normalized.displayField = column.displayField;

  return normalized;
};

// Fields of a column that can be changed via PUT /schema/:table/column/:name
export const applyColumnUpdate = (column, payload = {}) => {
  const updated = { ...column };
  for (const key of ["label", "type", "showInTable"]) {
    if (payload[key] !== undefined) updated[key] = payload[key];
  }
  updated.type = canonicalType(updated.type);
  assertType(updated.type);
  return updated;
};

export const normalizeTableSchema = (payload = {}) => {
  if (!payload.tableName || typeof payload.tableName !== "string") {
    throw new ValidationError("tableName is required");
  }

  return {
    tableName: payload.tableName,
    columns: (payload.columns ?? []).map(normalizeColumn),
    showInMenu: payload.showInMenu ?? true,
  };
};

// column types that make a readable name for a record (used for relation labels)
const DISPLAYABLE_TYPES = ["text", "number", "date", "textarea"];

// Which field of a table's records to show when another table links to it:
// the relation's explicit displayField, else the first visible text-like column.
export const pickDisplayField = (refSchema, displayField) => {
  const columns = refSchema?.columns ?? [];
  if (displayField && columns.some((c) => c.name === displayField)) {
    return displayField;
  }
  return (
    columns.find((c) => c.showInTable && DISPLAYABLE_TYPES.includes(c.type))?.name ||
    columns.find((c) => DISPLAYABLE_TYPES.includes(c.type))?.name ||
    "_id"
  );
};

// DB row -> API shape
export const toTableSchema = (row) =>
  row && {
    _id: row._id,
    tableName: row.table_name,
    columns: row.columns,
    showInMenu: row.show_in_menu,
    departments: row.departments ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
