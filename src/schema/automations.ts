import type pg from "pg";
import { dataTable } from "../db/dataTables.js";
import { query } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { getUserOptionsByIds, userLabel } from "../repo/userRepo.js";
import type { Column, CurrentUser, RecordData, TableSchema } from "../types.js";
import { getSchema } from "./schemaRepo.js";
import { pickDisplayField } from "./columns.js";
import { ME, TODAY } from "./columns.js";
import { applyFormulas } from "./formula.js";
import { emailNotifications } from "../mail/notifications.js";
import { emitChange, emitNotification } from "../live/events.js";

// After a record is saved (in the same transaction):
//  1. built-in: people newly picked in a User column are told ("Asha assigned you")
//  2. the table's automations: "when Status becomes Approved -> set Approved
//     on = today, notify the person who asked"
// Automations don't trigger other automations (no loops). Imports skip this.

export type Trigger = { when: "created" } | { when: "changed"; column: string; to?: string };
export type Action =
  | { do: "set"; column: string; value: unknown }
  | { do: "notify"; who: string; message?: string };
export interface Automation {
  _id: string;
  table_name: string;
  name: string;
  trigger: Trigger;
  actions: Action[];
  enabled: boolean;
}

// who to tell:
//   "$creator"         the person who created the record
//   "$managers"        people who can edit every record of the table (its managers)
//   "assignee"         the person in a User column
//   "employee.account" the person in a User column of the linked record
//                      (the Employee's Login account)
const CREATOR = "$creator";
const MANAGERS = "$managers";
const label = (c: Column) => c.label || c.name;

// a table by name: normally the saved one; an install passes the tables it's making
type SchemaOf = (name: string) => Promise<Pick<TableSchema, "tableName" | "columns"> | null | undefined> | Pick<TableSchema, "tableName" | "columns"> | null | undefined;

// "employee.account" -> the link and the User column of the linked table, when valid
const throughLink = async (schema: TableSchema, who: string, schemaOf: SchemaOf = getSchema) => {
  const [link, userColumn] = who.split(".");
  const column = schema.columns.find((c) => c.name === link && c.type === "relation" && c.ref);
  if (!column || !userColumn) return null;
  const target = await schemaOf(column.ref!);
  return target?.columns.some((c) => c.name === userColumn && c.type === "user") ? { link, table: target.tableName, userColumn } : null;
};

// People who can edit every record of the table (not just their own): its
// managers. With none yet, the admins, so requests never go unseen.
export async function managersOf(tableName: string, client: pg.PoolClient) {
  const { rows } = await query<{ _id: string }>(
    `SELECT DISTINCT u._id FROM users u
     JOIN roles r ON r._id = u.role_id OR r._id IN (SELECT role_id FROM user_roles WHERE user_id = u._id)
     WHERE u.is_active
       AND (r.permissions -> $1 ->> 'edit')::boolean IS TRUE
       AND COALESCE((r.permissions -> $1 ->> 'own')::boolean, false) IS FALSE`,
    [tableName],
    client
  );
  if (rows.length) return rows.map((r) => r._id);
  const { rows: admins } = await query<{ _id: string }>(
    `SELECT u._id FROM users u JOIN roles r ON r._id = u.role_id WHERE r.is_admin AND u.is_active`,
    [],
    client
  );
  return admins.map((r) => r._id);
}

/* ---------------- checking automations (admin) ---------------- */

export async function normalizeAutomation(schema: TableSchema, input: Record<string, unknown>, schemaOf: SchemaOf = getSchema) {
  const t = (input.trigger ?? {}) as Record<string, unknown>;
  let trigger: Trigger;
  if (t.when === "created") trigger = { when: "created" };
  else if (t.when === "changed") {
    const column = schema.columns.find((c) => c.name === t.column);
    if (!column) throw new HttpError(400, "Choose the field to watch");
    trigger = { when: "changed", column: column.name };
    if (typeof t.to === "string" && t.to) {
      if (column.type === "choice" && !column.options?.some((o) => o.label === t.to)) {
        throw new HttpError(400, `"${t.to}" isn't an option of ${label(column)}`);
      }
      trigger.to = t.to;
    }
  } else throw new HttpError(400, "Choose when it should happen");

  const raw = Array.isArray(input.actions) ? input.actions : [];
  if (!raw.length) throw new HttpError(400, "Add at least one thing to do");
  if (raw.length > 10) throw new HttpError(400, "At most 10 things to do");
  const actions: Action[] = [];
  for (const a of raw as Record<string, unknown>[]) actions.push(await normalizeAction(schema, a, schemaOf));
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
  return { name, trigger, actions, enabled: input.enabled !== false };
}

async function normalizeAction(schema: TableSchema, a: Record<string, unknown>, schemaOf: SchemaOf): Promise<Action> {
  {
    if (a?.do === "set") {
      const column = schema.columns.find((c) => c.name === a.column);
      if (!column || ["formula", "rollup", "autonumber"].includes(column.type)) throw new HttpError(400, "Choose a field to set");
      if (column.type === "date" && a.value !== TODAY && typeof a.value !== "string") throw new HttpError(400, `Choose a date for ${label(column)}`);
      return { do: "set", column: column.name, value: a.value ?? null };
    }
    if (a?.do === "notify") {
      const who = String(a.who ?? "");
      const ok =
        who === CREATOR ||
        who === MANAGERS ||
        schema.columns.some((c) => c.name === who && c.type === "user") ||
        (who.includes(".") && (await throughLink(schema, who, schemaOf)) !== null);
      if (!ok) throw new HttpError(400, "Choose who to tell");
      const message = typeof a.message === "string" ? a.message.trim().slice(0, 300) : "";
      return { do: "notify", who, ...(message ? { message } : {}) };
    }
    throw new HttpError(400, "Unknown action");
  }
}

export async function listAutomations(tableName: string, db?: pg.PoolClient) {
  const { rows } = await query<Automation>(`SELECT * FROM automations WHERE table_name = $1 ORDER BY created_at`, [tableName], db);
  return rows;
}

/* ---------------- running ---------------- */

const idsIn = (v: unknown) => ([] as unknown[]).concat(v ?? []).filter((x): x is string => typeof x === "string" && x.length > 0);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export async function notify(
  client: pg.PoolClient,
  userIds: string[],
  n: { title: string; body?: string; tableName?: string; recordId?: string; actor?: string },
  // email: false = the bell only (e.g. "your import finished")
  opts: { email?: boolean } = {}
) {
  const ids = [...new Set(userIds)].filter((id) => id && id !== n.actor);
  if (!ids.length) return;
  const { rows } = await query<{ _id: string; user_id: string }>(
    `INSERT INTO notifications (user_id, title, body, table_name, record_id, actor)
     SELECT u._id, $2, $3, $4, $5, $6 FROM users u WHERE u._id = ANY($1::text[]) AND u.is_active
     RETURNING _id, user_id`,
    [ids, n.title.slice(0, 300), (n.body ?? "").slice(0, 1000), n.tableName ?? null, n.recordId ?? null, n.actor ?? null],
    client
  );
  // and by email, for people who want it (see mail/notifications.ts); the bell at once
  if (opts.email !== false) await emailNotifications(client, rows, n);
  await emitNotification(
    rows.map((r) => r.user_id),
    n,
    client
  );
}

// a short name for a record, for messages
const nameOf = (schema: TableSchema, data: RecordData) => {
  const field = pickDisplayField(schema);
  const value = field === "_id" ? "" : data[field];
  return value === undefined || value === null || value === "" ? "a record" : String(value);
};

export async function afterSave(
  schema: TableSchema,
  recordId: string,
  before: RecordData | null, // null: just created
  after: RecordData,
  createdBy: string | null,
  actor: CurrentUser,
  client: pg.PoolClient
) {
  const title = nameOf(schema, after);
  const table = schema.tableName.replace(/_/g, " ");
  const actorName = actor.fullName || actor.username;
  // open screens of this table: "Hana changed this · Refresh"
  await emitChange(schema.tableName, recordId, actor, client);

  // 1. "assigned you": newly picked in a User column
  for (const column of schema.columns.filter((c) => c.type === "user")) {
    const was = new Set(idsIn(before?.[column.name]));
    const added = idsIn(after[column.name]).filter((id) => !was.has(id));
    if (added.length) {
      await notify(client, added, {
        title: `${actorName} put you as ${label(column)}`,
        body: `${title} (${table})`,
        tableName: schema.tableName,
        recordId,
        actor: actor._id,
      });
    }
  }

  // 2. automations
  const automations = (await listAutomations(schema.tableName, client)).filter((a) => a.enabled);
  if (!automations.length) return;
  const patch: RecordData = {};
  for (const a of automations) {
    const fires =
      a.trigger.when === "created"
        ? before === null
        : before === null
          ? // a new record "becomes" what it's created with: a ticket created
            // as Urgent fires "Priority becomes Urgent"
            Boolean(a.trigger.to) && ([] as unknown[]).concat(after[a.trigger.column] ?? []).includes(a.trigger.to)
          : JSON.stringify(before[a.trigger.column] ?? null) !== JSON.stringify(after[a.trigger.column] ?? null) &&
            (!a.trigger.to || ([] as unknown[]).concat(after[a.trigger.column] ?? []).includes(a.trigger.to));
    if (!fires) continue;
    for (const action of a.actions) {
      if (action.do === "set") {
        const column = schema.columns.find((c) => c.name === action.column);
        if (!column) continue;
        // on a new record, only fill what's still empty (a typed "Paid on" stays)
        const current = after[column.name];
        if (before === null && current !== null && current !== undefined && current !== "" && !(Array.isArray(current) && !current.length)) continue;
        const v = action.value === TODAY ? today() : action.value === ME ? (column.multiple ? [actor._id] : actor._id) : action.value;
        patch[column.name] = v;
      } else {
        const people = await recipients(schema, action.who, after, createdBy, client);
        const change =
          a.trigger.when === "changed"
            ? `${label(schema.columns.find((c) => c.name === (a.trigger as { column: string }).column)!)} is now ${String(after[a.trigger.column] ?? "empty")}`
            : `New in ${table}`;
        await notify(client, people, {
          title: action.message || `${title}: ${change}`,
          body: `${actorName} · ${title} (${table})`,
          tableName: schema.tableName,
          recordId,
          actor: actor._id,
        });
      }
    }
  }
  if (Object.keys(patch).length) {
    await query(`UPDATE ${dataTable(schema.tableName)} SET data = data || $2::jsonb, updated_at = now() WHERE _id = $1`, [recordId, JSON.stringify(patch)], client);
    await applyFormulas(schema, [recordId], client);
  }
}

// The people an automation tells (see the "who" kinds above).
export async function recipients(schema: TableSchema, who: string, after: RecordData, createdBy: string | null, client: pg.PoolClient) {
  if (who === CREATOR) return idsIn(createdBy);
  if (who === MANAGERS) return managersOf(schema.tableName, client);
  if (!who.includes(".")) return idsIn(after[who]);
  const path = await throughLink(schema, who);
  const linked = idsIn(after[path?.link ?? ""]);
  if (!path || !linked.length) return [];
  const { rows } = await query<{ v: unknown }>(
    `SELECT t.data -> $2 AS v FROM ${dataTable(path.table)} t WHERE t._id = ANY($1::text[])`,
    [linked, path.userColumn],
    client
  );
  return rows.flatMap((r) => idsIn(r.v));
}

// names for notification lists
export async function actorNames(ids: string[]) {
  const people = await getUserOptionsByIds(ids);
  return (id: string | null) => (id ? userLabel(people, id) : "");
}
