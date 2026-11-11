import type { CurrentUser, TableSchema } from "../types.js";
import { ME, MINE, TODAY } from "./columns.js";

// Default values for new records: columns missing from the payload get their
// column's default. A field sent empty on purpose stays empty.

// today's date (YYYY-MM-DD) in the server's time zone (TZ)
const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function withDefaults(
  schema: TableSchema,
  payload: Record<string, unknown>,
  user: Pick<CurrentUser, "_id" | "departments">
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const column of schema.columns) {
    if (column.default === undefined || column.name in payload) continue;
    let value: unknown = column.default;
    if (value === TODAY) value = today();
    else if (value === ME) value = column.multiple ? [user._id] : user._id;
    else if (value === MINE) {
      // only when it's clear which one: people in several departments choose
      if (user.departments.length !== 1) continue;
      value = column.multiple ? [user.departments[0]._id] : user.departments[0]._id;
    }
    out ??= { ...payload };
    out[column.name] = value;
  }
  return out ?? payload;
}
