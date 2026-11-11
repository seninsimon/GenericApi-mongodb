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
  // a reference given when the record is created: INV-0001, INV-0002, ...
  "autonumber",
  // worked out from other fields: {basic} + {allowances} (see schema/formula.ts)
  "formula",
  // a total over linked records: sum of a project's time logs (see schema/rollups.ts)
  "rollup",
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

export type RollupFn = "count" | "sum" | "avg" | "min" | "max";
export interface RollupConfig {
  from: string;
  via: string;
  fn: RollupFn;
  field?: string;
  where?: { column: string; in?: string[]; notIn?: string[] };
  type?: "number" | "date";
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
  // "relation" columns only: these records are edited inside the linked
  // record's form (an invoice's lines); see controllers/lineItems.ts
  inline?: boolean;
  // "choice" columns only
  options?: ChoiceOption[];
  // "autonumber" columns only; {YYYY} in the prefix = the year (restarts yearly)
  autonumber?: { prefix: string };
  // "formula" columns only; `type` (the result) is worked out from the expression
  formula?: { expression: string; type?: "number" | "text" | "date" | "boolean" };
  // "rollup" columns only: records of `from` whose link column `via` points
  // here, counted or summed (`field`), optionally only some (`where`).
  // `type` (number or date) is worked out from fn and field.
  rollup?: RollupConfig;
  // filled in on new records when no value is given (see schema/defaults.ts):
  // a fixed value, "today" (dates), "$me" (users) or "$mine" (departments)
  default?: unknown;
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
  // set on tables an app created: "projects.tasks", and the app ("projects")
  blueprintKey: string | null;
  appKey: string | null;
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
  // userColumns: this table's User columns. linkColumns: its links to tables
  // with User columns: a record is also yours when it links to a record you're
  // picked in (a leave request whose Employee has Login account = you)
  owner: {
    userId: string;
    userColumns: string[];
    linkColumns?: { column: string; table: string; userColumns: string[] }[];
  } | null;
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
