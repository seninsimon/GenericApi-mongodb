import { withTransaction } from "../db/pool.js";
import { insertRecord } from "../repo/recordRepo.js";
import { assignAutonumbers } from "../schema/autonumber.js";
import { withDefaults } from "../schema/defaults.js";
import { applyFormulas } from "../schema/formula.js";
import { fillFromUsers } from "../schema/fromUser.js";
import { getAllSchemas } from "../schema/schemaRepo.js";
import { checkRequired, coerceValues } from "../schema/validateRecord.js";
import type { CurrentUser } from "../types.js";

// The People directory's employee table, when that app is installed.
export const directoryTable = async () => (await getAllSchemas()).find((s) => s.blueprintKey === "people.employees") ?? null;

// "Add person": the new account also gets its entry in the People directory,
// linked to the login, with the name, email and phone typed once. Its
// Department comes from the account's department. Returns the entry's id,
// or null when there's no directory (or the entry can't be made as it is,
// e.g. a required column was added there).
export async function addToDirectory(person: CurrentUser, by: CurrentUser): Promise<{ table: string; id: string } | null> {
  const schema = await directoryTable();
  if (!schema) return null;
  const column = (name: string, type?: string) => schema.columns.find((c) => c.name === name && (!type || c.type === type));
  const payload: Record<string, unknown> = {};
  if (column("full_name")) payload.full_name = person.fullName || person.username;
  if (column("account", "user")) payload.account = person._id;
  if (column("email") && person.email) payload.email = person.email;
  if (column("phone") && person.phone) payload.phone = person.phone;

  const { values, errors } = coerceValues(schema, withDefaults(schema, payload, by));
  await fillFromUsers(schema, values);
  if (Object.keys(errors).length || Object.keys(checkRequired(schema, values)).length) return null;

  // on an "each department" table it's visible to the person's department(s) there
  const mine = person.departments.map((d) => d._id).filter((id) => schema.departments.some((d) => d._id === id));
  const departments = { departmentId: schema.byDepartment ? (mine[0] ?? null) : null, sharedDepartmentIds: schema.byDepartment ? mine.slice(1) : [] };

  const id = await withTransaction(async (client) => {
    await assignAutonumbers(schema, [values], client);
    const newId = await insertRecord(schema.tableName, values, departments, by._id, client);
    await applyFormulas(schema, [newId], client);
    return newId;
  });
  return { table: schema.tableName, id };
}
