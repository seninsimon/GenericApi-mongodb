// Shared domain types.

export const COLUMN_TYPES = [
  "text",
  "number",
  "date",
  "boolean",
  "relation",
  // a person: the _id of a user account
  "user",
  "image",
  "images",
  "file",
  "files",
  "richtext",
  "textarea",
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface Column {
  _id: string;
  name: string;
  label?: string;
  type: ColumnType;
  showInTable: boolean;
  required: boolean;
  // sort index on this column (fast sorting on big tables)
  indexed: boolean;
  ref: string | null;
  multiple: boolean;
  displayField?: string;
  fileConfig: { accept: string[]; maxSize: number; maxFiles: number };
  uploadPath: string;
}

export interface DepartmentRef {
  _id: string;
  name: string;
}

export interface TableSchema {
  _id: string;
  tableName: string;
  columns: Column[];
  showInMenu: boolean;
  departments: DepartmentRef[];
  createdAt: Date;
  updatedAt: Date;
}

export type Action = "view" | "create" | "edit" | "delete";
export type Permissions = Record<Action, boolean>;
export type PermissionMap = Record<string, Permissions>;

export interface CurrentUser {
  _id: string;
  username: string;
  fullName: string;
  email: string;
  phone: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  role: { _id: string; name: string; isAdmin: boolean; permissions: PermissionMap };
  departments: DepartmentRef[];
}

// One record as returned by the API.
export type RecordData = Record<string, unknown>;
export interface StoredRecord {
  _id: string;
  data: RecordData;
  departmentId: string | null;
  // user who created the record (null for records created before this was tracked, or by the system)
  createdBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}
