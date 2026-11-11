import type { Permissions } from "../types.js";

// Installable apps ("Projects", "HR", ...): a blueprint describes the tables,
// columns, links and roles an app adds. Installing turns it into ordinary
// tables that the company can then change like any other (see installer.ts).

// Like a column definition, but a link's `ref` is a table key: "tasks" (same
// app) or "people.employees" (another app, which must be in `needs`).
export type ColumnBlueprint = Record<string, unknown> & { name: string; label: string; type?: string; ref?: string };

export interface TableBlueprint {
  key: string; // unique in the app: "tasks" -> full key "projects.tasks"
  name: string; // preferred table name
  label: string;
  description: string;
  // can be left out in the preview (default true); required tables can't
  optional?: boolean;
  // false: not in the sidebar (lines edited inside their invoice)
  showInMenu?: boolean;
  columns: ColumnBlueprint[];
}

export interface RoleBlueprint {
  name: string;
  description: string;
  // by table key ("tasks", "people.employees") or "*" = every table of the app
  perms: Record<string, Partial<Permissions>>;
}

// A sample record. `$id` names it so other sample records can link to it
// with "@<table key>:<$id>" (e.g. "@projects:website").
export type SampleRow = Record<string, unknown> & { $id?: string };

export interface SampleContext {
  me: string; // the installing user's id (for User columns)
  date: (daysFromToday: number) => string; // YYYY-MM-DD
}

export interface AppBlueprint {
  key: string; // stable forever
  version: number;
  name: string;
  description: string;
  icon: string; // a Tabler icon name, e.g. "IconChecklist"
  // sidebar group for its tables (default: the app's name)
  group?: string;
  // apps whose tables this one links to; installed first when missing
  needs?: string[];
  tables: TableBlueprint[];
  // columns this app adds to another app's table (by full table key), e.g.
  // Inventory adds stock on hand to "products.products"; removed with the app
  extend?: Record<string, ColumnBlueprint[]>;
  roles?: RoleBlueprint[];
  sample?: (ctx: SampleContext) => Record<string, SampleRow[]>;
}

// An organization type: a set of apps installed together.
export interface BundleBlueprint {
  key: string;
  name: string;
  description: string;
  icon: string;
  apps: string[];
}
