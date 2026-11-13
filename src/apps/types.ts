import type { Permissions } from "../types.js";

// Installable apps ("Projects", "HR", ...): a blueprint describes the tables,
// columns, links and roles an app adds. Installing turns it into ordinary
// tables that the company can then change like any other (see installer.ts).

// Like a column definition, but a link's `ref` is a table key: "tasks" (same
// app) or "people.employees" (another app, which must be in `needs`).
// A choice may list `onlyManagers: ["Approved", "Rejected"]`: options only the
// Manager role may choose (an approval step).
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
  // "when Status becomes Approved -> notify the person who asked" (table key;
  // trigger and actions as in src/schema/automations.ts)
  automations?: { table: string; name: string; trigger: Record<string, unknown>; actions: Record<string, unknown>[] }[];
  sample?: (ctx: SampleContext) => Record<string, SampleRow[]>;
  // on the Home page: a few counts ("Open tasks") and one breakdown ("Tasks by status")
  dashboard?: DashboardBlueprint;
}

export type TileFilter = { field: string; op: string; value?: unknown; value2?: unknown };
export interface DashboardBlueprint {
  tiles: { label: string; table: string; filters?: TileFilter[] }[];
  breakdown?: { label: string; table: string; column: string };
}

// An organization type: a set of apps installed together.
export interface BundleBlueprint {
  key: string;
  name: string;
  description: string;
  icon: string;
  apps: string[];
  // starter departments, created with it (the admin can rename or drop them)
  departments?: string[];
}
