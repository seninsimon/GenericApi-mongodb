import { parse } from "csv-parse";
import { stringify } from "csv-stringify/sync";
import { ALL_RECORDS, allowedDepartments, can, recordScope, isAdmin } from "../auth/access.js";
import { checkNotApprovingOwn, keepItYours } from "../auth/ownership.js";
import { HttpError } from "../lib/http.js";
import { notify } from "../schema/automations.js";
import { withTransaction } from "../db/pool.js";
import { audit, diffRecord } from "../repo/auditRepo.js";
import { setProgress, type Job, type JobResult } from "../repo/jobRepo.js";
import { findByLabels, getRecordsByIds, insertRecords, updateRecord } from "../repo/recordRepo.js";
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
import { CREATED_BY_HEADER, DEPARTMENT_HEADER, ID_HEADER, LEGACY_DEPARTMENT_HEADER, PROBLEM_HEADER, parseCell } from "./csv.js";
import { emitChange } from "../live/events.js";

const BATCH_SIZE = 500;
const MAX_REPORTED_ERRORS = 1000;
const DEPARTMENT_KEY = "__department";

type ParsedRow = { line: number; payload: Record<string, unknown>; raw: Record<string, string>; id: string | null; department: string | null };
const ID_KEY = "__id";

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
        else complain(row.line, `${label}: there's no ${refSchema.tableName.replace(/_/g, " ").replace(/s$/, "")} called "${value}". Check the spelling, or add it first`);
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
        else complain(row.line, `${label}: there's no active person "${value}". Use their username or full name`);
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

// Import a CSV: rows without an ID are added; rows with an ID (from an export)
// update that record (only the columns in the file change). Problems are
// reported per row, saying how to fix them; the rows with problems can be
// downloaded with a "Problem" column, fixed and imported again. Imports don't
// run automations (no flood of notifications); the importer is told when it's done.
export async function runImport(job: Job) {
  const user = await getUserById(job.userId);
  if (!user?.isActive) throw new Error("The user who started this import no longer has access");
  const schema = await getSchema(job.tableName);
  if (!schema) throw new Error(`Table "${job.tableName}" no longer exists`);
  const canCreate = can(user, schema, "create");
  const canEdit = can(user, schema, "edit");
  if (!canCreate && !canEdit) throw new Error("You no longer have permission to add or change records in this table");

  const uploadKey = String(job.params.uploadKey ?? "");
  const allowed = allowedDepartments(user, schema);
  const allowedIds = new Set(allowed.map((d) => d._id));
  // "Visible to" may name any of the table's departments ("Engineering; Design"),
  // as long as one of them is the importer's own
  const byName = new Map(schema.departments.map((d) => [d.name.trim().toLowerCase(), d._id]));
  const defaultDepartment =
    typeof job.params.departmentId === "string" && allowed.some((d) => d._id === job.params.departmentId)
      ? job.params.departmentId
      : allowed.length === 1
        ? allowed[0]._id
        : allowed.length === 0 && isAdmin(user)
          ? null
          : undefined;

  const errors: { row: number; message: string }[] = [];
  // the rows with problems, as they were in the file, for the "fix and import again" file
  const problemRows: { raw: Record<string, string>; message: string }[] = [];
  const fail = (row: ParsedRow, message: string) => {
    if (errors.length < MAX_REPORTED_ERRORS) {
      errors.push({ row: row.line, message });
      problemRows.push({ raw: row.raw, message });
    }
  };

  // header -> column name (or department / ID / ignored)
  const ignoredHeaders: string[] = [];
  let fileColumns: string[] = []; // in the file's order, for the problem file
  let headerProblem: string | null = null;
  const mapHeader = (headers: string[]) => {
    const mapped = headers.map((h) => {
      const name = h.trim();
      const lower = name.toLowerCase();
      // the table's own columns come first (a column may be called "Department")
      const column = columnByNameOrLabel(schema, name);
      if (column) return column.name;
      if (lower === DEPARTMENT_HEADER.toLowerCase() || lower === LEGACY_DEPARTMENT_HEADER.toLowerCase()) return DEPARTMENT_KEY;
      if (lower === ID_HEADER.toLowerCase()) return ID_KEY;
      // exported for information, or from a problem file: skipped
      if (lower === CREATED_BY_HEADER.toLowerCase() || lower === PROBLEM_HEADER.toLowerCase()) return false;
      if (name) ignoredHeaders.push(name);
      return false; // csv-parse skips this field
    });
    fileColumns = mapped.filter((m): m is string => typeof m === "string");
    // without an ID column every row is new: a required column must be there
    if (!fileColumns.includes(ID_KEY)) {
      const missing = schema.columns.filter((c) => c.required && importable(c) && !fileColumns.includes(c.name) && c.default === undefined);
      if (missing.length) {
        headerProblem = `The file has no ${missing.map((c) => `"${c.label || c.name}"`).join(", ")} column${missing.length > 1 ? "s" : ""}, which every new record needs. Download the template from the Import window to see the columns.`;
      }
    }
    return mapped;
  };

  const source = await storage.get(uploadKey);
  const parser = source.body.pipe(
    parse({ bom: true, columns: mapHeader, skip_empty_lines: true, relax_column_count: true, trim: false })
  );

  let processed = 0;
  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let batch: ParsedRow[] = [];
  const scope = recordScope(user, schema);

  // "Visible to" cell -> departments, or a problem
  const departmentsOf = (row: ParsedRow): { departmentId: string | null; sharedDepartmentIds: string[] } | string | null => {
    if (!row.department) return null;
    const names = row.department.split(";").map((n) => n.trim()).filter(Boolean);
    const ids = [...new Set(names.map((n) => byName.get(n.toLowerCase())))];
    const unknown = names.filter((n) => !byName.has(n.toLowerCase()));
    if (unknown.length) return `Visible to: "${unknown.join(", ")}" isn't a department of this table (its departments: ${schema.departments.map((d) => d.name).join(", ")})`;
    if (!isAdmin(user) && schema.byDepartment && !ids.some((id) => allowedIds.has(id!))) return `Visible to: "${row.department}" must include one of your departments`;
    return { departmentId: ids[0] ?? null, sharedDepartmentIds: ids.slice(1) as string[] };
  };

  // "Due must be a date…" + what was in the cell
  const withCells = (row: ParsedRow, fieldErrors: Record<string, string>) =>
    Object.entries(fieldErrors).map(([name, message]) => {
      const cell = row.raw[name];
      return cell !== undefined && cell !== "" && !message.includes(`"${cell}"`) ? `${message} (the file has "${cell}")` : message;
    });

  const flush = async () => {
    if (!batch.length) return;
    const problems = await resolveRelations(user, schema, batch);
    await resolveUsers(schema, batch, problems);
    await resolveDepartmentColumns(schema, batch, problems);

    // the records the rows with an ID change (only ones this person may reach)
    const wanted = batch.map((r) => r.id).filter((id): id is string => Boolean(id));
    const existing = new Map((wanted.length ? await getRecordsByIds(schema.tableName, wanted, scope) : []).map((r) => [r._id, r]));

    const toAdd: { data: RecordData; departmentId: string | null; sharedDepartmentIds: string[] }[] = [];
    const toChange: { id: string; before: RecordData; values: RecordData; departments?: { departmentId: string | null; sharedDepartmentIds: string[] } }[] = [];

    for (const row of batch) {
      const messages = [...(problems.get(row.line) ?? [])];
      if (row.id) {
        // an update: only the columns in the file change
        const record = existing.get(row.id);
        if (!canEdit) messages.push("You can't change records in this table (no edit permission)");
        else if (!record) messages.push(`ID: there's no record "${row.id}" that you can change (it may have been deleted)`);
        if (messages.length || !record) {
          failed++;
          fail(row, messages.join("; "));
          continue;
        }
        for (const c of schema.columns) if (["autonumber", "formula", "rollup"].includes(c.type)) delete row.payload[c.name];
        const { values, errors: fieldErrors } = coerceValues(schema, row.payload);
        messages.push(...withCells(row, fieldErrors));
        const merged = { ...record.data, ...values };
        messages.push(...Object.values(checkRequired(schema, merged)), ...Object.values(checkChoices(schema, values, record.data, user)));
        const rule = await ownRules(schema, values, record.data, user);
        if (rule) messages.push(rule);
        const departments = departmentsOf(row);
        if (typeof departments === "string") messages.push(departments);
        if (messages.length) {
          failed++;
          fail(row, messages.join("; "));
        } else {
          toChange.push({ id: row.id, before: record.data, values, departments: typeof departments === "string" ? undefined : (departments ?? undefined) });
        }
        continue;
      }

      // a new record; columns missing from the file get their default
      if (!canCreate) {
        failed++;
        fail(row, "You can't add records to this table (no create permission): keep the ID to change an existing one");
        continue;
      }
      const { values, errors: fieldErrors } = coerceValues(schema, withDefaults(schema, row.payload, user));
      messages.push(...withCells(row, fieldErrors));
      const rule = await ownRules(schema, values, null, user);
      if (rule) messages.push(rule);
      messages.push(...Object.values(checkRequired(schema, values)), ...Object.values(checkChoices(schema, values, {}, user)));

      let departmentId: string | null | undefined = defaultDepartment;
      let sharedDepartmentIds: string[] = [];
      const departments = departmentsOf(row);
      if (typeof departments === "string") messages.push(departments);
      else if (departments) ({ departmentId, sharedDepartmentIds } = departments);
      else if (departmentId === undefined && schema.byDepartment) {
        messages.push('Visible to: choose a department (add a "Visible to" column, or pick one when importing)');
      }

      if (messages.length) {
        failed++;
        fail(row, [...new Set(messages)].join("; "));
      } else {
        toAdd.push({ data: values, departmentId: departmentId ?? null, sharedDepartmentIds });
      }
    }

    if (toAdd.length) {
      inserted += await withTransaction(async (client) => {
        // numbers for rows without one; numbers in the file are kept
        await assignAutonumbers(schema, toAdd.map((v) => v.data), client);
        const ids = await insertRecords(schema.tableName, toAdd, user._id, client);
        await emitChange(schema.tableName, null, user, client);
        await applyFormulas(schema, ids, client);
        await refreshParents(schema.tableName, toAdd.map((v) => v.data), client);
        return ids.length;
      });
    }
    if (toChange.length) {
      updated += await withTransaction(async (client) => {
        for (const c of toChange) {
          await updateRecord(schema.tableName, c.id, c.values, { scope: ALL_RECORDS, newDepartments: c.departments }, client);
          const changes = diffRecord(c.before, { ...c.before, ...c.values });
          if (Object.keys(changes).length) {
            await audit(
              null,
              { action: "update", entity: "record", tableName: schema.tableName, recordId: c.id, userId: user._id, username: user.username, changes: { ...changes, _via: "import" } },
              client
            );
          }
        }
        await applyFormulas(schema, toChange.map((c) => c.id), client);
        await refreshParents(schema.tableName, toChange.flatMap((c) => [c.before, { ...c.before, ...c.values }]), client);
        await emitChange(schema.tableName, null, user, client);
        return toChange.length;
      });
    }
    processed += batch.length;
    batch = [];
    await setProgress(job._id, processed);
  };

  let line = 1; // header
  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    if (headerProblem) throw new Error(headerProblem);
    line++;
    const payload: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(record)) {
      if (key === DEPARTMENT_KEY || key === ID_KEY) continue;
      const column = schema.columns.find((c) => c.name === key) as Column;
      payload[key] = parseCell(column, String(raw ?? ""));
    }
    const raw = Object.fromEntries(Object.entries(record).map(([k, v]) => [k, String(v ?? "")]));
    batch.push({ line, payload, raw, id: record[ID_KEY]?.trim() || null, department: record[DEPARTMENT_KEY]?.trim() || null });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  if (headerProblem) throw new Error(headerProblem);
  await flush();

  // the uploaded source isn't needed any more
  await storage.delete(uploadKey).catch(() => {});

  const result: JobResult = {
    rows: processed,
    inserted,
    updated,
    failed,
    errors: [
      ...(ignoredHeaders.length
        ? [{ row: 1, message: `These columns aren't in the table and were left out: ${ignoredHeaders.join(", ")}. Check their spelling against the template.` }]
        : []),
      ...errors,
    ].slice(0, 100),
  };

  // the rows with problems, as in the file plus a "Problem" column: fix them
  // there and import this file again
  let fileKey: string | null = null;
  if (problemRows.length) {
    fileKey = `imports/${job._id}-problems.csv`;
    const label = (name: string) =>
      name === DEPARTMENT_KEY ? DEPARTMENT_HEADER : name === ID_KEY ? ID_HEADER : (schema.columns.find((c) => c.name === name)?.label ?? name);
    await storage.put(
      fileKey,
      Buffer.from(
        stringify([[...fileColumns.map(label), PROBLEM_HEADER], ...problemRows.map((r) => [...fileColumns.map((c) => r.raw[c] ?? ""), r.message])], { bom: true })
      ),
      "text/csv; charset=utf-8"
    );
  }

  await audit(null, {
    action: "import",
    entity: "record",
    tableName: schema.tableName,
    userId: user._id,
    username: user.username,
    changes: { inserted, updated, failed, jobId: job._id },
  });

  // tell the person who started it (bell, at once; no email)
  const parts = [inserted && `${inserted} added`, updated && `${updated} updated`, failed && `${failed} with problems`].filter(Boolean);
  await withTransaction((client) =>
    notify(
      client,
      [user._id],
      {
        title: `Import into ${schema.tableName.replace(/_/g, " ")} finished: ${parts.join(", ") || "nothing to import"}`,
        body: failed ? "Open Imports & exports to see what to fix." : "",
        tableName: schema.tableName,
      },
      { email: false }
    )
  );

  return {
    result,
    progress: processed,
    fileKey,
    fileName: fileKey ? `${schema.tableName}-rows-to-fix.csv` : null,
  };
}

// "Own only" rules for an imported row (the record must be the importer's own,
// and nobody approves their own): a message, or null.
async function ownRules(schema: TableSchema, values: RecordData, before: RecordData | null, user: CurrentUser) {
  try {
    await keepItYours(schema, values, before, user);
    await checkNotApprovingOwn(schema, values, before ?? {}, user);
    return null;
  } catch (error) {
    return error instanceof HttpError ? error.message : String(error);
  }
}

// columns a file can fill (the server works out the others)
const importable = (c: Column) => !["formula", "rollup", "autonumber"].includes(c.type);
