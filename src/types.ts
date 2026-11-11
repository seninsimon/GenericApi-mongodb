// Shared domain types.

export const COLUMN_TYPES = [
  "text",
  "number",
  "date",
  "boolean",
  "relation",
  // a person: the _id of a user account
  "user",
  // one of the company's departments (data, e.g. "Works in"; not record access)
  "department",
  // one (or with `multiple`, several) of a fixed list of options, e.g. Status
  "choice",
  "image",
  "images",
  "file",
  "files",
  "richtext",
  "textarea",
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

// An option of a "choice" column. Records store the label; `id` stays the same
// when the option is renamed, so a rename can update existing records.
export interface ChoiceOption {
  id: string;
  label: string;
  color: string;
}

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
  // "choice" columns only
  options?: ChoiceOption[];
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
export type Permissions = Record<Action, boolean> & {
  // only the user's own records: ones they created, or where they're picked in
  // a "User" column (e.g. Employee, Assigned to)
  own?: boolean;
};

// Which records of a table a user can reach.
export interface RecordScope {
  // departments to limit to; null = every department and admins-only records (admins)
  departmentIds: string[] | null;
  // set when the user may only reach their own records (then departmentIds is null:
  // their own records count from any of the table's departments)
  owner: { userId: string; userColumns: string[] } | null;
}
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
