import { stringify } from "csv-stringify";
import { once } from "node:events";
import { can, recordScope } from "../auth/access.js";
import { getRecordsByIds, scanRecords } from "../repo/recordRepo.js";
import { setProgress, type Job } from "../repo/jobRepo.js";
import { departmentNames, getUserById, getUserOptionsByIds, userLabel } from "../repo/userRepo.js";
import { pickDisplayField } from "../schema/columns.js";
import { parseFilters } from "../schema/filters.js";
import { getSchema } from "../schema/schemaRepo.js";
import { storage } from "../storage.js";
import type { CurrentUser, StoredRecord, TableSchema } from "../types.js";
import { CREATED_BY_HEADER, DEPARTMENT_HEADER, formatCell } from "./csv.js";

// Look up display labels for the relation values in one batch, limited to the
// records the user could see themselves.
async function relationLabels(user: CurrentUser, schema: TableSchema, batch: StoredRecord[]) {
  const labels = new Map<string, Map<string, string>>();
  for (const column of schema.columns) {
    if (column.type !== "relation" || !column.ref) continue;
    const refSchema = await getSchema(column.ref);
    if (!refSchema || !can(user, refSchema, "view")) continue;

    const ids = [...new Set(batch.flatMap((r) => ([] as unknown[]).concat(r.data[column.name] ?? []).map(String)))];
    if (!ids.length) continue;
    const display = pickDisplayField(refSchema, column.displayField);
    const found = await getRecordsByIds(refSchema.tableName, ids, recordScope(user, refSchema));
    labels.set(column.name, new Map(found.map((r) => [r._id, String((display === "_id" ? r._id : r.data[display]) ?? r._id)])));
  }
  return labels;
}

// Names for user columns and "Created by" in one batch.
async function peopleLabels(schema: TableSchema, batch: StoredRecord[]) {
  const userColumns = schema.columns.filter((c) => c.type === "user");
  const ids = batch.flatMap((r) => [
    r.createdBy ?? "",
    ...userColumns.flatMap((c) => ([] as unknown[]).concat(r.data[c.name] ?? []).map(String)),
  ]);
  const people = await getUserOptionsByIds(ids);
  return { label: (id: unknown) => userLabel(people, id), map: new Map([...people].map(([id, o]) => [id, o.label])) };
}

export async function runExport(job: Job) {
  // runs with the permissions of the user who started it, checked now
  const user = await getUserById(job.userId);
  if (!user?.isActive) throw new Error("The user who started this export no longer has access");
  const schema = await getSchema(job.tableName);
  if (!schema) throw new Error(`Table "${job.tableName}" no longer exists`);
  if (!can(user, schema, "view")) throw new Error("You no longer have access to this table");

  // "Visible to" only when the table is shared with several departments (as in the list)
  const withDepartment = schema.departments.length > 1;
  const header = [
    ...schema.columns.map((c) => c.label || c.name),
    ...(withDepartment ? [DEPARTMENT_HEADER] : []),
    CREATED_BY_HEADER,
  ];
  const departments = schema.columns.some((c) => c.type === "department") ? await departmentNames() : new Map<string, string>();
  // BOM so Excel opens UTF-8 correctly
  const csv = stringify({ bom: true });
  const key = `exports/${job._id}.csv`;
  const upload = storage.put(key, csv, "text/csv; charset=utf-8");
  let uploadError: unknown = null;
  upload.catch((err) => {
    uploadError = err;
  });

  const write = async (line: string[]) => {
    if (uploadError) throw uploadError;
    if (!csv.write(line)) await Promise.race([once(csv, "drain"), upload]);
  };

  let rows = 0;
  try {
    await write(header);
    // filters are re-validated: columns may have changed since the job was queued
    const filters = parseFilters(job.params.filters ?? [], schema, user);
    const search = typeof job.params.search === "string" ? job.params.search : "";
    for await (const batch of scanRecords(schema, { scope: recordScope(user, schema), search, filters })) {
      const labels = await relationLabels(user, schema, batch);
      const people = await peopleLabels(schema, batch);
      for (const record of batch) {
        await write([
          ...schema.columns.map((c) =>
            formatCell(
              c,
              record.data[c.name],
              c.type === "user" ? people.map : c.type === "department" ? departments : labels.get(c.name)
            )
          ),
          ...(withDepartment ? [record.departmentName ?? ""] : []),
          people.label(record.createdBy),
        ]);
      }
      rows += batch.length;
      await setProgress(job._id, rows);
    }
    csv.end();
    await upload;
  } catch (error) {
    csv.destroy();
    await upload.catch(() => {});
    await storage.delete(key).catch(() => {});
    throw error;
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return {
    result: { rows },
    progress: rows,
    fileKey: key,
    fileName: `${schema.tableName}-${stamp}.csv`,
  };
}
