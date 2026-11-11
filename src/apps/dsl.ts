import type { Permissions } from "../types.js";
import type { ColumnBlueprint, RoleBlueprint } from "./types.js";

// Short helpers for writing table definitions (apps and the demo seed).
type Extra = Partial<ColumnBlueprint>;

export const text = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "text", ...extra });
export const longText = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "textarea", ...extra });
export const richText = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "richtext", ...extra });
export const num = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "number", ...extra });
// dates are usually sorted by: indexed
export const date = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "date", indexed: true, ...extra });
export const bool = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "boolean", ...extra });
export const link = (name: string, label: string, ref: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "relation", ref, ...extra });
export const user = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "user", ...extra });
export const dept = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "department", ...extra });
export const image = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "image", ...extra });
export const file = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "file", ...extra });
export const files = (name: string, label: string, extra: Extra = {}): ColumnBlueprint => ({ name, label, type: "files", ...extra });
// a fixed list of options: plain labels, or [label, colour] pairs
export const choice = (name: string, label: string, options: (string | [string, string])[], extra: Extra = {}): ColumnBlueprint => ({
  name, label, type: "choice", options: options.map((o) => (typeof o === "string" ? { label: o } : { label: o[0], color: o[1] })), ...extra,
});
// INV-0001, INV-0002, ... given automatically to new records
export const autonum = (name: string, label: string, prefix: string, extra: Extra = {}): ColumnBlueprint => ({
  name, label, type: "autonumber", autonumber: { prefix }, indexed: true, ...extra,
});
// worked out from other fields when a record is saved
export const formula = (name: string, label: string, expression: string, extra: Extra = {}): ColumnBlueprint => ({
  name, label, type: "formula", formula: { expression }, ...extra,
});
// a total over linked records: rollup("hours", "Hours", { from: "time_logs", via: "task", fn: "sum", field: "hours" })
export const rollup = (
  name: string,
  label: string,
  config: { from: string; via: string; fn: "count" | "sum" | "avg" | "min" | "max"; field?: string; where?: { column: string; in?: string[]; notIn?: string[] } },
  extra: Extra = {}
): ColumnBlueprint => ({ name, label, type: "rollup", rollup: config, ...extra });
export const hidden = { showInTable: false };

/* ---------------- roles ---------------- */

// Every app adds to the same two roles (a user has one role, so per-app roles
// would clash): Manager = everything in the app's tables, Staff = everyday work.
export const VIEW: Partial<Permissions> = { view: true };
export const WORK: Partial<Permissions> = { view: true, create: true, edit: true };
export const ALL: Partial<Permissions> = { view: true, create: true, edit: true, delete: true };
// personal records: only the ones the user created or is picked in
export const OWN = (p: Partial<Permissions>): Partial<Permissions> => ({ ...p, own: true });

export const managerRole = (): RoleBlueprint => ({
  name: "Manager",
  description: "Runs the team: full access to the apps' tables",
  perms: { "*": ALL },
});
export const staffRole = (perms: Record<string, Partial<Permissions>>): RoleBlueprint => ({
  name: "Staff",
  description: "Everyday work in the apps; only their own records where they're personal",
  perms,
});
