import { query } from "../db/pool.js";
import type { RecordData, TableSchema } from "../types.js";

// A Department column can follow a User column: the People directory's
// "Department" follows "Login account". When a person is picked there and the
// department is still empty, it's filled in with that person's department(s)
// (their account's), so it isn't typed twice. It isn't kept in sync later:
// it's a starting value, and stays editable.
//
// `before`: the record's saved values (edits), so a department already set
// is never replaced.
export async function fillFromUsers(schema: TableSchema, values: RecordData, before: RecordData = {}) {
  for (const column of schema.columns) {
    if (column.type !== "department" || !column.fromUser || !(column.fromUser in values)) continue;
    const current = column.name in values ? values[column.name] : before[column.name];
    if (current !== null && current !== undefined && current !== "" && !(Array.isArray(current) && !current.length)) continue;
    const picked = values[column.fromUser];
    const userId = Array.isArray(picked) ? picked[0] : picked;
    if (typeof userId !== "string" || !userId) continue;
    const { rows } = await query<{ department_id: string }>(
      `SELECT ud.department_id FROM user_departments ud JOIN departments d ON d._id = ud.department_id
       WHERE ud.user_id = $1 ORDER BY d.name`,
      [userId]
    );
    if (!rows.length) continue;
    values[column.name] = column.multiple ? rows.map((r) => r.department_id) : rows[0].department_id;
  }
}
