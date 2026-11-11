import { parse } from "csv-parse";
import { stringify } from "csv-stringify/sync";
import { allowedDepartments, can, recordScope, isAdmin } from "../auth/access.js";
import { withTransaction } from "../db/pool.js";
import { audit } from "../repo/auditRepo.js";
import { setProgress, type Job, type JobResult } from "../repo/jobRepo.js";
import { findByLabels, getRecordsByIds, insertRecords } from "../repo/recordRepo.js";
import { departmentNames, findActiveUsers, getUserById } from "../repo/userRepo.js";
import { columnByNameOrLabel, pickDisplayField } from "../schema/columns.js";
import { getSchema } from "../schema/schemaRepo.js";
import { assignAutonumbers } from "../schema/autonumber.js";
import { withDefaults } from "../schema/defaults.js";
import { applyFormulas } from "../schema/formula.js";
import { refreshParents } from "../schema/rollups.js";
import { checkChoices, checkRequired, coerceValues } from "../schema/validateRecord.js";
import { storage } from "../storage.js";
import type { Column, CurrentUser, RecordData, TableSchema } from "../types.js";
import { CREATED_BY_HEADER, DEPARTMENT_HEADER, LEGACY_DEPARTMENT_HEADER, parseCell } from "./csv.js";

const BATCH_SIZE = 500;
const MAX_REPORTED_ERRORS = 1000;
const DEPARTMENT_KEY = "__department";

type ParsedRow = { line: number; payload: Record<string, unknown>; department: string | null };

// Map each relation cell (label or id) to a record id the user can see.
async function resolveRelations(user: CurrentUser, schema: TableSchema, rows: ParsedRow[]) {
  const problems = new Map<number, string[]>();
  const complain = (line: number, message: string) => problems.set(line, [...(problems.get(line) ?? []), message]);

  for (const column of schema.columns) {
    if (column.type !== "relation" || !column.ref) continue;
    const cells = rows.filter((r) => Array.isArray(r.payload[column.name]));
    if (!cells.length) continue;
    const label = column.label || column.name;

    const refSchema = await getSchema(column.ref);
    if (!refSchema || !can(user, refSchema, "view")) {
      cells.forEach((r) => complain(r.line, `${label}: you can't link to "${column.ref}"`));
      continue;
    }
    const filter = recordScope(user, refSchema);
    const values = [...new Set(cells.flatMap((r) => r.payload[column.name] as string[]))];

    const byId = new Set((await getRecordsByIds(refSchema.tableName, values, filter)).map((r) => r._id));
    const display = pickDisplayField(refSchema, column.displayField);
    const byLabel = new Map<string, string[]>();
    if (display !== "_id") {
      for (const match of await findByLabels(refSchema.tableName, display, values.filter((v) => !byId.has(v)), filter)) {
        byLabel.set(match.label, [...(byLabel.get(match.label) ?? []), match._id]);
      }
    }

    for (const row of cells) {
      const ids: string[] = [];
      for (const value of row.payload[column.name] as string[]) {
        if (byId.has(value)) ids.push(value);
        else if ((byLabel.get(value)?.length ?? 0) === 1) ids.push(byLabel.get(value)![0]);
        else if (byLabel.get(value)?.length) complain(row.line, `${label}: "${value}" matches several records, use the id`);
        else complain(row.line, `${label}: no record "${value}"`);
      }
      if (!column.multiple && ids.length > 1) complain(row.line, `${label}: only one value allowed`);
      row.payload[column.name] = column.multiple ? ids : (ids[0] ?? null);
    }
  }
  return problems;
}

// Map each user cell (name, username or id) to an active user's id.
async function resolveUsers(schema: TableSchema, rows: ParsedRow[], problems: Map<number, string[]>) {
  const complain = (line: number, message: string) => problems.set(line, [...(problems.get(line) ?? []), message]);

  for (const column of schema.columns) {
    if (column.type !== "user") continue;
    const cells = rows.filter((r) => Array.isArray(r.payload[column.name]));
    if (!cells.length) continue;
    const label = column.label || column.name;

    const found = await findActiveUsers(cells.flatMap((r) => r.payload[column.name] as string[]));
    const lookup = (value: string) => {
      const v = value.trim().toLowerCase();
      const byId = found.filter((u) => u.value === value.trim());
      if (byId.length) return byId;
      const byUsername = found.filter((u) => u.username.toLowerCase() === v);
      return byUsername.length ? byUsername : found.filter((u) => u.label.trim().toLowerCase() === v);
    };

    for (const row of cells) {
      const ids: string[] = [];
      for (const value of row.payload[column.name] as string[]) {
        const matches = lookup(value);
        if (matches.length === 1) ids.push(matches[0].value);
        else if (matches.length) complain(row.line, `${label}: "${value}" matches several people, use the username`);
        else complain(row.line, `${label}: no active user "${value}"`);
      }
      if (!column.multiple && ids.length > 1) complain(row.line, `${label}: only one person allowed`);
      row.payload[column.name] = column.multiple ? ids : (ids[0] ?? null);
    }
  }
}

// Map each department cell (name or id) to a department id.
async function resolveDepartmentColumns(schema: TableSchema, rows: ParsedRow[], problems: Map<number, string[]>) {
  const columns = schema.columns.filter((c) => c.type === "department");
  if (!columns.length) return;
  const complain = (line: number, message: string) => problems.set(line, [...(problems.get(line) ?? []), message]);
  const names = await departmentNames();
  const byName = new Map([...names].map(([id, name]) => [name.trim().toLowerCase(), id]));

  for (const column of columns) {
    const label = column.label || column.name;
    for (const row of rows.filter((r) => Array.isArray(r.payload[column.name]))) {
      const ids: string[] = [];
      for (const value of row.payload[column.name] as string[]) {
        const id = names.has(value) ? value : byName.get(value.trim().toLowerCase());
        if (id) ids.push(id);
        else complain(row.line, `${label}: no department "${value}"`);
      }
      if (!column.multiple && ids.length > 1) complain(row.line, `${label}: only one department allowed`);
      row.payload[column.name] = column.multiple ? ids : (ids[0] ?? null);
    }
  }
}

export async function runImport(job: Job) {
  const user = await getUserById(job.userId);
  if (!user?.isActive) throw new Error("The user who started this import no longer has access");
  const schema = await getSchema(job.tableName);
  if (!schema) throw new Error(`Table "${job.tableName}" no longer exists`);
  if (!can(user, schema, "create")) throw new Error("You no longer have permission to add records to this table");

  const uploadKey = String(job.params.uploadKey ?? "");
  const allowed = allowedDepartments(user, schema);
  const byName = new Map(allowed.map((d) => [d.name.toLowerCase(), d._id]));
  const defaultDepartment =
    typeof job.params.departmentId === "string" && allowed.some((d) => d._id === job.params.departmentId)
      ? job.params.departmentId
      : allowed.length === 1
        ? allowed[0]._id
        : allowed.length === 0 && isAdmin(user)
          ? null
          : undefined;

  const errors: { row: number; message: string }[] = [];
  const fail = (row: number, message: string) => {
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ row, message });
  };

  // header -> column name (or department / ignored)
  const ignoredHeaders: string[] = [];
  const mapHeader = (headers: string[]) =>
    headers.map((h) => {
      const name = h.trim();
      const lower = name.toLowerCase();
      // the table's own columns come first (a column may be called "Department")
      const column = columnByNameOrLabel(schema, name);
      if (column) return column.name;
      if (lower === DEPARTMENT_HEADER.toLowerCase() || lower === LEGACY_DEPARTMENT_HEADER.toLowerCase()) {
        return DEPARTMENT_KEY;
      }
      // exported for information; always set to the importing user
      if (lower === CREATED_BY_HEADER.toLowerCase()) return false;
      ignoredHeaders.push(name);
      return false; // csv-parse skips this field
    });

  const source = await storage.get(uploadKey);
  const parser = source.body.pipe(
    parse({ bom: true, columns: mapHeader, skip_empty_lines: true, relax_column_count: true, trim: false })
  );

  let processed = 0;
  let inserted = 0;
  let failed = 0;
  let batch: ParsedRow[] = [];

  const flush = async () => {
    if (!batch.length) return;
    const problems = await resolveRelations(user, schema, batch);
    await resolveUsers(schema, batch, problems);
    await resolveDepartmentColumns(schema, batch, problems);
    const valid: { data: RecordData; departmentId: string | null }[] = [];

    for (const row of batch) {
      const messages = [...(problems.get(row.line) ?? [])];
      // columns missing from the file get their default
      const { values, errors: fieldErrors } = coerceValues(schema, withDefaults(schema, row.payload, user));
      messages.push(
        ...Object.values(fieldErrors),
        ...Object.values(checkRequired(schema, values)),
        ...Object.values(checkChoices(schema, values, {}, user))
      );

      let departmentId: string | null | undefined = defaultDepartment;
      if (row.department) {
        departmentId = byName.get(row.department.toLowerCase());
        if (departmentId === undefined) messages.push(`Visible to: "${row.department}" isn't one of your departments for this table`);
      } else if (departmentId === undefined) {
        messages.push("Visible to: choose a department (add a \"Visible to\" column, or pick one when importing)");
      }

      if (messages.length) {
        failed++;
        fail(row.line, messages.join("; "));
      } else {
        valid.push({ data: values, departmentId: departmentId ?? null });
      }
    }

    if (valid.length) {
      inserted += await withTransaction(async (client) => {
        // numbers for rows without one; numbers in the file are kept
        await assignAutonumbers(schema, valid.map((v) => v.data), client);
        const ids = await insertRecords(schema.tableName, valid, user._id, client);
        await applyFormulas(schema, ids, client);
        await refreshParents(schema.tableName, valid.map((v) => v.data), client);
        return ids.length;
      });
    }
    processed += batch.length;
    batch = [];
    await setProgress(job._id, processed);
  };

  let line = 1; // header
  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    line++;
    const payload: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(record)) {
      if (key === DEPARTMENT_KEY) continue;
      const column = schema.columns.find((c) => c.name === key) as Column;
      payload[key] = parseCell(column, String(raw ?? ""));
    }
    batch.push({ line, payload, department: record[DEPARTMENT_KEY]?.trim() || null });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  // the uploaded source isn't needed any more
  await storage.delete(uploadKey).catch(() => {});

  const result: JobResult = {
    rows: processed,
    inserted,
    failed,
    errors: [
      ...(ignoredHeaders.length ? [{ row: 1, message: `Ignored unknown columns: ${ignoredHeaders.join(", ")}` }] : []),
      ...errors,
    ].slice(0, 100),
  };

  // full error report as a downloadable CSV
  let fileKey: string | null = null;
  if (errors.length) {
    fileKey = `imports/${job._id}-errors.csv`;
    await storage.put(
      fileKey,
      Buffer.from(stringify([["row", "error"], ...errors.map((e) => [String(e.row), e.message])], { bom: true })),
      "text/csv; charset=utf-8"
    );
  }

  await audit(null, {
    action: "import",
    entity: "record",
    tableName: schema.tableName,
    userId: user._id,
    username: user.username,
    changes: { inserted, failed, jobId: job._id },
  });

  return {
    result,
    progress: processed,
    fileKey,
    fileName: fileKey ? `${schema.tableName}-import-errors.csv` : null,
  };
}
