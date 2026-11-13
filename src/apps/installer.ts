import type pg from "pg";
import { dataTable, ensureDataTable, syncColumnIndexes } from "../db/dataTables.js";
import { query, withTransaction } from "../db/pool.js";
import { HttpError } from "../lib/http.js";
import { insertRecord, type RecordDepartments } from "../repo/recordRepo.js";
import { assignAutonumbers, backfillAutonumber } from "../schema/autonumber.js";
import { FILE_COLUMN_TYPES, normalizeColumn, validateTableName } from "../schema/columns.js";
import { withDefaults } from "../schema/defaults.js";
import { applyFormulas, checkFormulas, formulaRefs } from "../schema/formula.js";
import { checkRollups, rollupsOver } from "../schema/rollups.js";
import { normalizeAutomation } from "../schema/automations.js";
import { deleteTable, findRelationsTo, getAllSchemas, getSchema, invalidateSchemas } from "../schema/schemaRepo.js";
import { coerceValues } from "../schema/validateRecord.js";
import type { Column, CurrentUser, Permissions, RecordData, TableSchema } from "../types.js";
import { APP_BY_KEY, BUNDLE_BY_KEY, fullKey } from "./index.js";
import type { AppBlueprint, ColumnBlueprint, TableBlueprint } from "./types.js";

// Turns app blueprints into ordinary tables.
//
//   plan()    works out what installing would do (the preview shows exactly this)
//   install() does it, in one transaction: tables, links between them, sharing
//             with departments, the app's own roles ("Projects · Manager",
//             "Projects · Staff"), and sample records
//
// A table is recognised by its blueprint key ("projects.tasks"), stored on the
// table. A later app linking to "people.employees" finds that table even after
// it was renamed or edited, so apps connect instead of duplicating tables.

export interface InstallOptions {
  // full table key -> false to leave an optional table out
  tables?: Record<string, boolean>;
  // share the new tables with these departments
  departmentIds?: string[];
  // departments to create (or reuse, by name) and share with: an
  // organization type's starter departments, as the admin edited them.
  // Not given: the organization type's own list
  departments?: string[];
  sampleData?: boolean;
  // a table name that's already taken by one of your own tables:
  // "new" (default) = create "tasks_2"; "use" = use your table for it
  conflicts?: Record<string, "new" | "use">;
  // a drafted app's draft (kept with the install, see apps/draft.ts)
  draft?: unknown;
}

export interface PlannedTable {
  key: string; // full key
  app: string;
  label: string;
  description: string;
  // create: new table; reuse: an app already made it; use: one of your tables
  // takes the part; skip: left out
  action: "create" | "reuse" | "use" | "skip";
  tableName: string | null;
  optional: boolean;
  links: { column: string; to: string; toLabel: string }[];
  // link (and formula) columns left out because their table is left out
  dropped: string[];
  // the preferred name belongs to one of your tables
  conflict: { existing: string; choice: "new" | "use" } | null;
}

export interface InstallPlan {
  apps: { key: string; name: string; status: "install" | "installed"; pulledIn: boolean }[];
  tables: PlannedTable[];
  // columns added to tables of other apps ("Stock" on Products)
  extensions: { table: string; label: string; columns: string[] }[];
  // the apps' roles: "Projects · Manager" (level "manager"), "Projects · Staff"
  roles: { name: string; level: string; action: "create" | "extend"; tables: string[] }[];
  // an organization type's starter departments (exists: one has that name already)
  departments: { name: string; exists: boolean }[];
  hasSample: boolean;
}

type Ctx = {
  appsToInstall: AppBlueprint[];
  installed: Set<string>;
  schemas: TableSchema[];
};

/* ---------------- resolving apps ---------------- */

// The requested apps plus everything they need, in install order.
function resolveApps(keys: string[]): { app: AppBlueprint; pulledIn: boolean }[] {
  const order: { app: AppBlueprint; pulledIn: boolean }[] = [];
  const visiting = new Set<string>();
  const visit = (key: string, pulledIn: boolean) => {
    const app = APP_BY_KEY.get(key);
    if (!app) throw new HttpError(400, `Unknown app "${key}"`);
    if (order.some((o) => o.app.key === key)) return;
    if (visiting.has(key)) throw new HttpError(500, `Apps need each other in a circle: ${key}`);
    visiting.add(key);
    for (const need of app.needs ?? []) visit(need, true);
    visiting.delete(key);
    order.push({ app, pulledIn });
  };
  for (const key of keys) visit(key, false);
  return order;
}

// "it" (a bundle) -> its apps; app keys pass through
export const expandKeys = (keys: string[]) =>
  [...new Set(keys.flatMap((k) => BUNDLE_BY_KEY.get(k)?.apps ?? [k]))];

async function installedApps(db?: pg.PoolClient) {
  const { rows } = await query<{ key: string }>(`SELECT key FROM installed_apps`, [], db);
  return new Set(rows.map((r) => r.key));
}

/* ---------------- plan ---------------- */

const tableBlueprint = (key: string) => {
  const [appKey, tableKey] = key.split(".");
  return APP_BY_KEY.get(appKey)?.tables.find((t) => t.key === tableKey) ?? null;
};
const labelOf = (key: string) => tableBlueprint(key)?.label ?? key;

function planTables(ctx: Ctx, options: InstallOptions): PlannedTable[] {
  const byKey = new Map<string, PlannedTable>();
  const taken = new Set(ctx.schemas.map((s) => s.tableName.toLowerCase()));

  // tables of apps installed earlier: reuse when still there
  for (const schema of ctx.schemas) {
    if (!schema.blueprintKey) continue;
    const bp = tableBlueprint(schema.blueprintKey);
    byKey.set(schema.blueprintKey, {
      key: schema.blueprintKey,
      app: schema.blueprintKey.split(".")[0],
      label: bp?.label ?? schema.tableName,
      description: bp?.description ?? "",
      action: "reuse",
      tableName: schema.tableName,
      optional: false,
      links: [],
      dropped: [],
      conflict: null,
    });
  }

  const planned: PlannedTable[] = [];
  for (const app of ctx.appsToInstall) {
    for (const table of app.tables) {
      const key = fullKey(app, table.key);
      const existing = byKey.get(key);
      if (existing) {
        planned.push(existing);
        continue;
      }
      const optional = table.optional !== false;
      const entry: PlannedTable = {
        key,
        app: app.key,
        label: table.label,
        description: table.description,
        action: "create",
        tableName: null,
        optional,
        links: [],
        dropped: [],
        conflict: null,
      };
      if (optional && options.tables?.[key] === false) entry.action = "skip";
      else if (taken.has(table.name.toLowerCase())) {
        const choice = options.conflicts?.[key] === "use" ? "use" : "new";
        const mine = ctx.schemas.find((s) => s.tableName.toLowerCase() === table.name.toLowerCase())!;
        entry.conflict = { existing: mine.tableName, choice };
        if (choice === "use" && !mine.blueprintKey) {
          entry.action = "use";
          entry.tableName = mine.tableName;
        } else {
          let n = 2;
          while (taken.has(`${table.name}_${n}`.toLowerCase())) n++;
          entry.tableName = `${table.name}_${n}`;
        }
      } else entry.tableName = table.name;
      if (entry.tableName && entry.action !== "use") taken.add(entry.tableName.toLowerCase());
      byKey.set(key, entry);
      planned.push(entry);
    }
  }

  // links: to tables in the plan or already there; columns linking to a table
  // that's left out (or gone) are dropped, with formulas that use them
  for (const entry of planned) {
    if (entry.action === "reuse" || entry.action === "skip") continue;
    const bp = tableBlueprint(entry.key)!;
    const app = APP_BY_KEY.get(entry.app)!;
    const { kept, dropped } = columnsFor(app, bp, byKey);
    entry.dropped = dropped.map((c) => c.label);
    entry.links = kept
      .filter((c) => c.type === "relation" && c.ref)
      .map((c) => ({ column: c.label, to: fullKey(app, c.ref!), toLabel: labelOf(fullKey(app, c.ref!)) }));
  }
  // tables made by apps installed earlier that the new ones link to: shown as "reused"
  for (const target of new Set(planned.flatMap((t) => t.links.map((l) => l.to)))) {
    const entry = byKey.get(target);
    if (entry?.action === "reuse" && !planned.includes(entry)) planned.push(entry);
  }
  return planned;
}

// A table's columns with link targets resolved; links to missing tables dropped.
function columnsFor(app: AppBlueprint, table: TableBlueprint, byKey: Map<string, PlannedTable>) {
  const dropped: ColumnBlueprint[] = [];
  const present = (key: string) => {
    const target = byKey.get(fullKey(app, key));
    return Boolean(target && target.action !== "skip" && target.tableName);
  };
  let kept = table.columns.filter((c) => {
    // links, and totals over a table, need that table
    const target = c.type === "relation" ? c.ref : c.type === "rollup" ? (c.rollup as { from?: string } | undefined)?.from : null;
    if (!target) return true;
    const ok = present(target);
    if (!ok) dropped.push(c);
    return ok;
  });
  // formulas using a dropped column go too (repeat: formulas using those)
  for (let changed = true; changed; ) {
    changed = false;
    const gone = new Set(dropped.map((c) => c.name));
    kept = kept.filter((c) => {
      if (c.type !== "formula") return true;
      const uses = formulaRefs(c as unknown as Column);
      if (uses.some((r) => gone.has(r))) {
        dropped.push(c);
        changed = true;
        return false;
      }
      return true;
    });
  }
  return { kept, dropped };
}

// Each app has its own roles, one per role in its blueprint: "Projects ·
// Manager" (level "manager"), "Projects · Staff". People get them through
// their app access, so someone can manage HR and be staff in Projects.
type PlannedRole = {
  app: string;
  level: string;
  name: string;
  description: string;
  perms: Record<string, Partial<Permissions>>;
  action: "create" | "extend";
};
const roleKey = (app: string, level: string) => `${app}:${level}`;

function planRoles(
  apps: AppBlueprint[],
  tables: Pick<PlannedTable, "key" | "app" | "action" | "tableName">[],
  existing: Map<string, { _id: string; permissions: Record<string, Permissions> }>
): PlannedRole[] {
  const roles: PlannedRole[] = [];
  for (const app of apps) {
    const appTables = tables.filter((t) => t.app === app.key && t.action !== "skip" && t.tableName);
    for (const role of app.roles ?? []) {
      const level = role.name.toLowerCase();
      const perms: Record<string, Partial<Permissions>> = {};
      for (const [key, p] of Object.entries(role.perms)) {
        const targets = key === "*" ? appTables : appTables.filter((t) => t.key === fullKey(app, key));
        for (const t of targets) perms[t.tableName!] = { ...perms[t.tableName!], ...p };
      }
      const found = existing.get(roleKey(app.key, level));
      roles.push({
        app: app.key,
        level,
        name: `${app.name} · ${role.name}`,
        description: level === "manager" ? `Everything in ${app.name}` : `Everyday work in ${app.name}; personal records only their own`,
        // an existing role only gains rights on tables it has none for
        perms: Object.fromEntries(Object.entries(perms).filter(([table]) => !found?.permissions[table])),
        action: found ? "extend" : "create",
      });
    }
  }
  return roles;
}

async function loadAppRoles(db?: pg.PoolClient) {
  const { rows } = await query<{ _id: string; app_key: string; app_level: string; permissions: Record<string, Permissions> }>(
    `SELECT _id, app_key, app_level, permissions FROM roles WHERE app_key IS NOT NULL`,
    [],
    db
  );
  return new Map(rows.map((r) => [roleKey(r.app_key, r.app_level), r]));
}

// Create or extend the planned roles; returns their ids by app and level.
async function saveAppRoles(roles: PlannedRole[], client: pg.PoolClient) {
  const ids = new Map<string, string>();
  const existing = await loadAppRoles(client);
  for (const role of roles) {
    const perms = Object.fromEntries(
      Object.entries(role.perms).map(([t, p]) => [
        t,
        { view: Boolean(p.view), create: Boolean(p.create), edit: Boolean(p.edit), delete: Boolean(p.delete), own: Boolean(p.own) },
      ])
    );
    const found = existing.get(roleKey(role.app, role.level));
    if (found) {
      // gains rights on new tables, never loses any (permissions on the right win)
      await query(`UPDATE roles SET permissions = $2::jsonb || permissions, updated_at = now() WHERE _id = $1`, [found._id, JSON.stringify(perms)], client);
      ids.set(roleKey(role.app, role.level), found._id);
      continue;
    }
    // a role of your own may already have the name
    let name = role.name;
    for (let n = 2; (await query(`SELECT 1 FROM roles WHERE lower(name) = lower($1)`, [name], client)).rowCount; n++) name = `${role.name} (${n})`;
    const { rows } = await query<{ _id: string }>(
      `INSERT INTO roles (name, description, permissions, app_key, app_level) VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING _id`,
      [name, role.description, JSON.stringify(perms), role.app, role.level],
      client
    );
    ids.set(roleKey(role.app, role.level), rows[0]._id);
  }
  return ids;
}

// Options only managers may choose ("Approved"): `managerIdFor` gives the
// role id for a table's app. replace: only that role (a new install); add:
// that role too (roles added to an app installed before apps had roles).
async function markApprovals(
  entries: { key: string; tableName: string }[],
  managerIdFor: (appKey: string) => string | undefined,
  mode: "replace" | "add",
  client: pg.PoolClient,
  // the table's schema: during an install, the one being built (the new
  // tables aren't visible outside the transaction yet)
  schemaOf: (tableName: string) => TableSchema | undefined | Promise<TableSchema | null>
) {
  for (const entry of entries) {
    const bp = tableBlueprint(entry.key);
    const managerId = managerIdFor(entry.key.split(".")[0]);
    const schema = await schemaOf(entry.tableName);
    if (!bp || !managerId || !schema) continue;
    const columns = schema.columns;
    let changed = false;
    for (const c of bp.columns) {
      const only = c.onlyManagers as string[] | undefined;
      const column = columns.find((x) => x.name === c.name);
      if (!only?.length || !column?.options) continue;
      for (const o of column.options) {
        if (!only.includes(o.label)) continue;
        o.roles = mode === "replace" ? [managerId] : [...new Set([...(o.roles ?? []), managerId])];
        changed = true;
      }
    }
    if (changed) {
      await query(`UPDATE table_schemas SET columns = $2::jsonb WHERE table_name = $1`, [entry.tableName, JSON.stringify(columns)], client);
    }
  }
}

// Installed apps whose blueprint got newer (its version) get the app's new
// and corrected automations, once, at start-up:
//   - an automation the app has that isn't there by name is added;
//   - one with the same name and trigger (as the app made it) gets the app's
//     current actions (e.g. "tell the employee" instead of "tell the creator");
//   - one you changed (another trigger) is left alone.
// Then the install is marked with the new version.
// equal JSON values, whatever the order of their keys (Postgres reorders them)
const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
      : v;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

export async function upgradeInstalledApps() {
  const installed = await listInstalled();
  const schemas = await getAllSchemas();
  const upgraded: string[] = [];
  for (const row of installed) {
    const app = APP_BY_KEY.get(row.key);
    if (!app || row.version >= app.version) continue;
    await withTransaction(async (client) => {
      for (const a of app.automations ?? []) {
        const schema = schemas.find((s) => s.blueprintKey === fullKey(app, a.table));
        if (!schema) continue; // the table was left out, or removed
        let clean;
        try {
          clean = await normalizeAutomation(schema, a);
        } catch {
          continue; // a column it needs was removed or renamed
        }
        const { rows } = await query<{ _id: string; trigger: unknown }>(
          `SELECT _id, trigger FROM automations WHERE table_name = $1 AND name = $2`,
          [schema.tableName, clean.name],
          client
        );
        if (!rows.length) {
          await query(
            `INSERT INTO automations (table_name, name, trigger, actions) VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
            [schema.tableName, clean.name, JSON.stringify(clean.trigger), JSON.stringify(clean.actions)],
            client
          );
        } else if (sameJson(rows[0].trigger, clean.trigger)) {
          await query(`UPDATE automations SET actions = $2::jsonb, updated_at = now() WHERE _id = $1`, [rows[0]._id, JSON.stringify(clean.actions)], client);
        }
      }
      await query(`UPDATE installed_apps SET version = $2 WHERE key = $1`, [app.key, app.version], client);
    });
    upgraded.push(app.key);
  }
  return upgraded;
}

// Apps installed before apps had their own roles get them once (at start-up),
// with the same rights the shared Manager/Staff roles gave them. Approval
// steps then also accept the app's Manager role. Safe to run again.
export async function ensureAppRoles() {
  const installed = await listInstalled();
  if (!installed.length) return 0;
  const existing = await loadAppRoles();
  const schemas = await getAllSchemas();
  let added = 0;
  for (const row of installed) {
    const app = APP_BY_KEY.get(row.key);
    if (!app?.roles?.length || app.roles.every((r) => existing.has(roleKey(app.key, r.name.toLowerCase())))) continue;
    const tables = schemas
      .filter((s) => s.appKey === app.key && s.blueprintKey)
      .map((s) => ({ key: s.blueprintKey!, app: app.key, action: "create" as const, tableName: s.tableName }));
    await withTransaction(async (client) => {
      const ids = await saveAppRoles(planRoles([app], tables, existing), client);
      await markApprovals(tables, (appKey) => ids.get(roleKey(appKey, "manager")), "add", client, getSchema);
    });
    added++;
  }
  if (added) await invalidateSchemas();
  return added;
}

async function buildPlan(keys: string[], options: InstallOptions, db?: pg.PoolClient) {
  const requested = expandKeys(keys);
  if (!requested.length) throw new HttpError(400, "Choose an app to install");
  const resolved = resolveApps(requested);
  const installed = await installedApps(db);
  const ctx: Ctx = {
    appsToInstall: resolved.filter((r) => !installed.has(r.app.key)).map((r) => r.app),
    installed,
    schemas: await getAllSchemas(),
  };
  const tables = planTables(ctx, options);
  const roles = planRoles(ctx.appsToInstall, tables, await loadAppRoles(db));
  const plan: InstallPlan = {
    apps: resolved.map((r) => ({
      key: r.app.key,
      name: r.app.name,
      status: installed.has(r.app.key) ? "installed" : "install",
      pulledIn: r.pulledIn && !requested.includes(r.app.key),
    })),
    tables,
    roles: roles.map((r) => ({ name: r.name, level: r.level, action: r.action, tables: Object.keys(r.perms) })),
    extensions: ctx.appsToInstall.flatMap((app) =>
      Object.entries(app.extend ?? {})
        .map(([key, columns]) => {
          const target = ctx.schemas.find((s) => s.blueprintKey === key);
          const planned = tables.find((t) => t.key === key && t.action !== "skip");
          const name = target?.tableName ?? planned?.tableName;
          return name ? { table: name, label: labelOf(key), columns: columns.map((c) => c.label) } : null;
        })
        .filter((e): e is { table: string; label: string; columns: string[] } => e !== null)
    ),
    departments: await suggestedDepartments(keys, db),
    hasSample: ctx.appsToInstall.some((a) => a.sample),
  };
  return { plan, ctx, roles };
}

// The starter departments of the organization types being installed.
async function suggestedDepartments(keys: string[], db?: pg.PoolClient) {
  const names = [...new Set(keys.flatMap((k) => BUNDLE_BY_KEY.get(k)?.departments ?? []))];
  if (!names.length) return [];
  const { rows } = await query<{ name: string }>(`SELECT name FROM departments`, [], db);
  const taken = new Set(rows.map((r) => r.name.trim().toLowerCase()));
  return names.map((name) => ({ name, exists: taken.has(name.toLowerCase()) }));
}

// Create the named departments (or find them by name); returns their ids.
async function ensureDepartments(names: string[], client: pg.PoolClient) {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of names.slice(0, 30)) {
    const name = String(raw ?? "").trim().slice(0, 100);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const found = await query<{ _id: string }>(`SELECT _id FROM departments WHERE lower(name) = lower($1) LIMIT 1`, [name], client);
    if (found.rows[0]) {
      ids.push(found.rows[0]._id);
      continue;
    }
    const made = await query<{ _id: string }>(`INSERT INTO departments (name) VALUES ($1) RETURNING _id`, [name], client);
    ids.push(made.rows[0]._id);
  }
  return ids;
}

export async function plan(keys: string[], options: InstallOptions = {}): Promise<InstallPlan> {
  return (await buildPlan(keys, options)).plan;
}

/* ---------------- install ---------------- */

const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function install(keys: string[], options: InstallOptions, user: CurrentUser) {
  let departmentIds = [...new Set(options.departmentIds ?? [])];
  const created: TableSchema[] = [];
  const touched: string[] = [];

  const result = await withTransaction(async (client) => {
    // one install at a time
    await query(`SELECT pg_advisory_xact_lock(hashtext('erp_install_apps'))`, [], client);
    const { plan: p, ctx, roles } = await buildPlan(keys, options, client);
    if (!ctx.appsToInstall.length) throw new HttpError(400, "Those apps are already installed");

    if (departmentIds.length) {
      const { rows } = await query<{ _id: string }>(`SELECT _id FROM departments WHERE _id = ANY($1::text[])`, [departmentIds], client);
      if (rows.length !== departmentIds.length) throw new HttpError(400, "A chosen department doesn't exist");
    }
    // an organization type's starter departments (as edited in the preview)
    const starter = Array.isArray(options.departments) ? options.departments : p.departments.map((d) => d.name);
    const starterIds = await ensureDepartments(starter, client);
    departmentIds = [...new Set([...departmentIds, ...starterIds])];

    const byKey = new Map(p.tables.map((t) => [t.key, t]));
    const schemaFor = new Map<string, TableSchema>(); // table name -> schema being written

    // 1. tables: every new table at once, so links between them just work.
    // Work out all column lists first (totals need the tables they add up).
    const built = new Map<PlannedTable, Column[]>();
    for (const entry of p.tables) {
      if (entry.action !== "create" && entry.action !== "use") continue;
      const app = APP_BY_KEY.get(entry.app)!;
      const { kept } = columnsFor(app, tableBlueprint(entry.key)!, byKey);
      const tableOf = (key: string) => byKey.get(fullKey(app, key))!.tableName;
      built.set(
        entry,
        kept.map((c) => {
          const rollup = c.rollup as { from: string } | undefined;
          return normalizeColumn({
            ...c,
            ...(c.type === "relation" && c.ref ? { ref: tableOf(c.ref) } : {}),
            ...(c.type === "rollup" && rollup ? { rollup: { ...rollup, from: tableOf(rollup.from) } } : {}),
          } as Record<string, unknown> & { name: string });
        })
      );
    }
    const columnsByName = new Map([...built].map(([entry, cols]) => [entry.tableName!, cols]));
    const columnsOf = async (name: string) => columnsByName.get(name) ?? (await getSchema(name))?.columns ?? null;

    for (const entry of p.tables) {
      if (entry.action !== "create" && entry.action !== "use") continue;
      const columns = built.get(entry)!;

      if (entry.action === "create") {
        const name = validateTableName(entry.tableName);
        await checkRollups(name, columns, columnsOf);
        checkFormulas(columns);
        await query(
          // clock_timestamp(): tables keep the app's order in lists and the sidebar
          // by_department false: everyone whose role can use the app sees its records
          `INSERT INTO table_schemas (table_name, columns, show_in_menu, blueprint_key, app_key, by_department, created_at)
           VALUES ($1, $2::jsonb, $5, $3, $4, false, clock_timestamp())`,
          [name, JSON.stringify(columns), entry.key, entry.app, tableBlueprint(entry.key)!.showInMenu !== false],
          client
        );
        await ensureDataTable(name, client);
        if (departmentIds.length) {
          await query(
            `INSERT INTO table_departments (table_name, department_id) SELECT $1, unnest($2::text[])`,
            [name, departmentIds],
            client
          );
        }
        const schema = { tableName: name, columns, departments: [], byDepartment: false, blueprintKey: entry.key, appKey: entry.app } as unknown as TableSchema;
        schemaFor.set(name, schema);
        created.push(schema);
      } else {
        // one of your tables takes the part: add the columns it lacks, change nothing else
        const mine = ctx.schemas.find((s) => s.tableName === entry.tableName)!;
        const missing = columns.filter((c) => !mine.columns.some((m) => m.name === c.name));
        const merged = [...mine.columns, ...missing];
        await checkRollups(mine.tableName, merged, columnsOf);
        checkFormulas(merged);
        await query(
          `UPDATE table_schemas SET columns = $2::jsonb, blueprint_key = $3, app_key = COALESCE(app_key, $4), updated_at = now()
            WHERE table_name = $1`,
          [mine.tableName, JSON.stringify(merged), entry.key, entry.app],
          client
        );
        for (const column of missing.filter((c) => c.type === "autonumber")) {
          await backfillAutonumber(mine.tableName, column, client);
        }
        const schema = { ...mine, columns: merged, blueprintKey: entry.key };
        await applyFormulas(schema, null, client);
        schemaFor.set(mine.tableName, schema);
        touched.push(mine.tableName);
      }
    }

    // 1b. columns apps add to other apps' tables (Inventory's stock on Products)
    const extended: Record<string, Record<string, string[]>> = {}; // app -> table -> columns
    for (const app of ctx.appsToInstall) {
      for (const [key, blueprintColumns] of Object.entries(app.extend ?? {})) {
        const target = byKey.get(key) ?? (await getAllSchemas()).find((s) => s.blueprintKey === key);
        const tableName = target && "tableName" in target ? target.tableName : null;
        if (!tableName) continue;
        const tableOf = (k: string) => byKey.get(fullKey(app, k))?.tableName ?? null;
        const columns = blueprintColumns
          .filter((c) => (c.type === "rollup" ? tableOf((c.rollup as { from: string }).from) : c.type === "relation" ? tableOf(c.ref!) : true))
          .map((c) => {
            const rollup = c.rollup as { from: string } | undefined;
            return normalizeColumn({
              ...c,
              ...(c.type === "relation" && c.ref ? { ref: tableOf(c.ref) } : {}),
              ...(c.type === "rollup" && rollup ? { rollup: { ...rollup, from: tableOf(rollup.from) } } : {}),
            } as Record<string, unknown> & { name: string });
          });
        const current = schemaFor.get(tableName) ?? (await getSchema(tableName));
        if (!current) continue;
        const missing = columns.filter((c) => !current.columns.some((m) => m.name === c.name));
        if (!missing.length) continue;
        const merged = [...current.columns, ...missing];
        await checkRollups(tableName, merged, columnsOf);
        checkFormulas(merged);
        await query(`UPDATE table_schemas SET columns = $2::jsonb, updated_at = now() WHERE table_name = $1`, [
          tableName,
          JSON.stringify(merged),
        ], client);
        const schema = { ...current, columns: merged } as TableSchema;
        schemaFor.set(tableName, schema);
        columnsByName.set(tableName, merged);
        await applyFormulas(schema, null, client);
        if (!touched.includes(tableName) && !created.some((c) => c.tableName === tableName)) touched.push(tableName);
        (extended[app.key] ??= {})[tableName] = missing.map((c) => c.name);
      }
    }

    // 2. the apps' own roles ("Projects · Manager"), and approval steps:
    // options only the app's Manager role may choose
    const roleIds = await saveAppRoles(roles, client);
    await markApprovals(
      p.tables.filter((t) => t.action === "create" && t.tableName).map((t) => ({ key: t.key, tableName: t.tableName! })),
      (appKey) => roleIds.get(roleKey(appKey, "manager")),
      "replace",
      client,
      (name) => schemaFor.get(name)
    );

    // 2c. the apps' automations, on tables made now
    for (const app of ctx.appsToInstall) {
      for (const a of app.automations ?? []) {
        const entry = byKey.get(fullKey(app, a.table));
        const schema = entry?.action === "create" && entry.tableName ? schemaFor.get(entry.tableName) : undefined;
        if (!schema) continue;
        // links may point at tables made in this same install
        const clean = await normalizeAutomation(schema, a, async (name) => schemaFor.get(name) ?? (await getSchema(name)));
        await query(
          `INSERT INTO automations (table_name, name, trigger, actions) VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
          [schema.tableName, clean.name, JSON.stringify(clean.trigger), JSON.stringify(clean.actions)],
          client
        );
      }
    }

    // 3. sample records (only into tables made now, never into your own)
    const sampleIds: Record<string, Record<string, string[]>> = {};
    const sampleRefs: Record<string, Record<string, string>> = {};
    if (options.sampleData) {
      const ids = await earlierSampleRefs(client); // "<full key>:<$id>" -> record id
      for (const app of ctx.appsToInstall) {
        if (!app.sample) continue;
        const rows = app.sample({
          me: user._id,
          date: (days) => isoDate(new Date(Date.now() + days * 86_400_000)),
        });
        for (const table of app.tables) {
          const key = fullKey(app, table.key);
          const entry = byKey.get(key)!;
          const schema = entry.tableName ? schemaFor.get(entry.tableName) : undefined;
          if (!schema || entry.action !== "create") continue;
          for (const raw of rows[table.key] ?? []) {
            const id = await insertSample(schema, app, raw, ids, { departmentId: departmentIds[0] ?? null, sharedDepartmentIds: departmentIds.slice(1) }, user, client);
            if (!id) continue;
            if (raw.$id) {
              ids.set(`${key}:${raw.$id}`, id);
              (sampleRefs[app.key] ??= {})[`${key}:${raw.$id}`] = id;
            }
            ((sampleIds[app.key] ??= {})[schema.tableName] ??= []).push(id);
          }
          await applyFormulas(schema, sampleIds[app.key]?.[schema.tableName] ?? [], client);
        }
      }
    }

    // totals over the sample records (twice: totals of totals)
    if (options.sampleData) {
      for (let pass = 0; pass < 2; pass++) for (const schema of schemaFor.values()) await applyFormulas(schema, null, client);
    }

    // 4. remember what each app added
    for (const app of ctx.appsToInstall) {
      const mine = p.tables.filter((t) => t.app === app.key && t.action === "create").map((t) => t.tableName!);
      await query(
        `INSERT INTO installed_apps (key, version, installed_by, options, sample_ids, created_tables, sample_refs)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], $7::jsonb)`,
        [
          app.key,
          app.version,
          user._id,
          JSON.stringify({ ...options, departmentIds, extended: extended[app.key] ?? {} }),
          JSON.stringify(sampleIds[app.key] ?? {}),
          mine,
          JSON.stringify(sampleRefs[app.key] ?? {}),
        ],
        client
      );
    }
    return { plan: p, apps: ctx.appsToInstall.map((a) => a.key), sampleIds };
  });

  // after commit: caches and indexes
  await invalidateSchemas();
  for (const name of [...created.map((s) => s.tableName), ...touched]) {
    await ensureDataTable(name);
    const schema = await getSchema(name);
    if (schema) await syncColumnIndexes(schema);
  }
  return {
    apps: result.apps,
    tables: result.plan.tables.filter((t) => t.action === "create" || t.action === "use").map((t) => ({ key: t.key, tableName: t.tableName!, label: t.label, action: t.action })),
    roles: result.plan.roles,
    sampleRecords: Object.values(result.sampleIds).reduce((n, byTable) => n + Object.values(byTable).flat().length, 0),
  };
}

// Named sample records of apps installed earlier that still exist, so new
// sample records can link to them (HR's sample leave -> People's sample staff).
async function earlierSampleRefs(client: pg.PoolClient) {
  const refs = new Map<string, string>();
  const { rows } = await query<{ sample_refs: Record<string, string> }>(`SELECT sample_refs FROM installed_apps`, [], client);
  const byTable = new Map<string, [string, string][]>();
  for (const [ref, id] of rows.flatMap((r) => Object.entries(r.sample_refs ?? {}))) {
    const table = (await getAllSchemas()).find((s) => s.blueprintKey === ref.split(":")[0])?.tableName;
    if (table) byTable.set(table, [...(byTable.get(table) ?? []), [ref, id]]);
  }
  for (const [table, entries] of byTable) {
    const { rows: found } = await query<{ _id: string }>(
      `SELECT _id FROM ${dataTable(table)} WHERE _id = ANY($1::text[])`,
      [entries.map(([, id]) => id)],
      client
    );
    const alive = new Set(found.map((f) => f._id));
    for (const [ref, id] of entries) if (alive.has(id)) refs.set(ref, id);
  }
  return refs;
}

// One sample record: "@table:id" links become record ids (rows whose required
// links can't be filled are left out), defaults and auto-numbers as usual.
async function insertSample(
  schema: TableSchema,
  app: AppBlueprint,
  raw: Record<string, unknown>,
  ids: Map<string, string>,
  departments: RecordDepartments, // visible to every department the app was installed for
  user: CurrentUser,
  client: pg.PoolClient
): Promise<string | null> {
  const payload: Record<string, unknown> = {};
  for (const column of schema.columns) {
    const value = raw[column.name];
    if (value === undefined) continue;
    const resolve = (v: unknown) => {
      if (typeof v !== "string" || !v.startsWith("@")) return v;
      const [key, sid] = v.slice(1).split(":");
      // "@tasks:x" (this app) or "@employees:x" (another app in this install)
      const candidates = [fullKey(app, key), ...[...ids.keys()].filter((k) => k.endsWith(`.${key}:${sid}`)).map((k) => k.split(":")[0])];
      for (const c of candidates) {
        const id = ids.get(`${c}:${sid}`);
        if (id) return id;
      }
      return null;
    };
    payload[column.name] = Array.isArray(value) ? value.map(resolve).filter(Boolean) : resolve(value);
  }
  if (schema.columns.some((c) => c.required && c.type === "relation" && payload[c.name] == null && raw[c.name] !== undefined)) {
    return null;
  }
  const { values } = coerceValues(schema, withDefaults(schema, payload, user));
  const records: RecordData[] = [values];
  await assignAutonumbers(schema, records, client);
  return insertRecord(schema.tableName, records[0], departments, user._id, client);
}

/* ---------------- uninstall / sample data ---------------- */

export async function listInstalled() {
  const { rows } = await query<{
    key: string;
    version: number;
    installed_at: Date;
    installed_by: string | null;
    sample_ids: Record<string, string[]>;
    created_tables: string[];
  }>(`SELECT key, version, installed_at, installed_by, sample_ids, created_tables FROM installed_apps ORDER BY installed_at`);
  return rows;
}

export async function uninstall(key: string) {
  const app = (await listInstalled()).find((a) => a.key === key);
  if (!app) throw new HttpError(404, "That app isn't installed");
  const others = await listInstalled();
  const needing = others.filter((o) => o.key !== key && APP_BY_KEY.get(o.key)?.needs?.includes(key));
  if (needing.length) {
    throw new HttpError(409, `${needing.map((o) => APP_BY_KEY.get(o.key)?.name ?? o.key).join(", ")} need${needing.length === 1 ? "s" : ""} it. Remove ${needing.length === 1 ? "that app" : "those apps"} first.`);
  }
  const tables = app.created_tables;
  // columns this app added to other apps' tables (removed below, so they don't block)
  const { rows: opts } = await query<{ options: { extended?: Record<string, string[]> } }>(
    `SELECT options FROM installed_apps WHERE key = $1`,
    [key]
  );
  const extendedCols = opts[0]?.options?.extended ?? {};
  const isExtension = (table: string, column: string) => (extendedCols[table] ?? []).includes(column);
  for (const name of tables) {
    const outside = (await findRelationsTo(name)).filter((r) => !tables.includes(r.tableName));
    if (outside.length) {
      throw new HttpError(409, `"${outside[0].tableName}" links to "${name}". Remove that link column first.`);
    }
    const totals = (await rollupsOver(name)).filter(
      (u) => !tables.includes(u.schema.tableName) && !isExtension(u.schema.tableName, u.column.name)
    );
    if (totals.length) {
      throw new HttpError(409, `The total "${totals[0].column.label || totals[0].column.name}" in "${totals[0].schema.tableName}" adds up "${name}". Remove that column first.`);
    }
  }
  // columns it added to other apps' tables go first
  for (const [table, names] of Object.entries(extendedCols)) {
    const schema = await getSchema(table);
    if (!schema || tables.includes(table)) continue;
    const remaining = schema.columns.filter((c) => !names.includes(c.name));
    try {
      checkFormulas(remaining);
    } catch {
      throw new HttpError(409, `A formula in "${table}" uses columns this app added. Change that formula first.`);
    }
    await query(`UPDATE table_schemas SET columns = $2::jsonb, updated_at = now() WHERE table_name = $1`, [table, JSON.stringify(remaining)]);
  }
  await invalidateSchemas();

  const removedFiles: string[] = [];
  for (const name of tables) {
    const schema = await getSchema(name);
    if (!schema) continue;
    const fileColumns = schema.columns.filter((c) => FILE_COLUMN_TYPES.includes(c.type)).map((c) => c.name);
    removedFiles.push(...(await deleteTable(schema, fileColumns)));
  }
  await query(`DELETE FROM installed_apps WHERE key = $1`, [key]);
  await query(`UPDATE table_schemas SET blueprint_key = NULL, app_key = NULL WHERE app_key = $1`, [key]);
  // its roles go too; anyone whose main role it was becomes a Member
  await query(
    `UPDATE users SET role_id = (SELECT _id FROM roles WHERE lower(name) = 'member' LIMIT 1)
     WHERE role_id IN (SELECT _id FROM roles WHERE app_key = $1)`,
    [key]
  );
  await query(`DELETE FROM roles WHERE app_key = $1`, [key]);
  await invalidateSchemas();
  return { removedTables: tables, removedFiles };
}

export async function removeSample(key: string) {
  const app = (await listInstalled()).find((a) => a.key === key);
  if (!app) throw new HttpError(404, "That app isn't installed");
  let removed = 0;
  await withTransaction(async (client) => {
    for (const [table, ids] of Object.entries(app.sample_ids ?? {})) {
      if (!(await getSchema(table)) || !ids.length) continue;
      const { rowCount } = await query(`DELETE FROM ${dataTable(table)} WHERE _id = ANY($1::text[])`, [ids], client);
      removed += rowCount ?? 0;
    }
    await query(`UPDATE installed_apps SET sample_ids = '{}'::jsonb, sample_refs = '{}'::jsonb WHERE key = $1`, [key], client);
  });
  return { removed };
}
