import type { Request, Response } from "express";
import { APP_BY_KEY, APPS, BUNDLES, fullKey } from "../apps/index.js";
import { aiDraftsEnabled, draftWithClaude, fromDraft, loadDraftedApps, registerApp } from "../apps/draft.js";
import type { AppBlueprint } from "../apps/types.js";
import { can } from "../auth/access.js";
import { getAllSchemas } from "../schema/schemaRepo.js";
import type { TableSchema } from "../types.js";
import { install, listInstalled, plan, removeSample, uninstall, type InstallOptions } from "../apps/installer.js";
import { HttpError, param } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import { deleteUploads } from "../storage.js";

// Settings -> Apps (admins only): the catalog, a preview of an install, and
// installing / removing apps.

// A drafted app (from "Describe your organization") travels as its draft; the
// server turns it into a blueprint again on every call, so it's checked each time.
const body = (req: Request) => {
  const { apps, options, draft } = (req.body ?? {}) as { apps?: unknown; options?: InstallOptions; draft?: unknown };
  if (draft !== undefined) {
    const app = registerApp(fromDraft(draft));
    return { apps: [app.key], options: { ...(options ?? {}), draft } as InstallOptions };
  }
  if (!Array.isArray(apps) || !apps.length || !apps.every((a) => typeof a === "string")) {
    throw new HttpError(400, "Choose an app to install");
  }
  return { apps: apps as string[], options: options ?? {} };
};

// GET /apps
export async function listAppsHandler(_req: Request, res: Response) {
  await loadDraftedApps();
  const installed = new Map((await listInstalled()).map((a) => [a.key, a]));
  // the catalog, plus apps drafted with AI that are installed
  const drafted = [...installed.keys()].filter((k) => !APPS.some((a) => a.key === k)).flatMap((k) => APP_BY_KEY.get(k) ?? []);
  res.json({
    aiDrafts: aiDraftsEnabled(),
    apps: [...APPS, ...drafted].map((app) => {
      const row = installed.get(app.key);
      return {
        key: app.key,
        name: app.name,
        description: app.description,
        icon: app.icon,
        group: app.group ?? app.name,
        needs: app.needs ?? [],
        tables: app.tables.map((t) => ({ key: t.key, label: t.label, description: t.description })),
        installed: row
          ? {
              version: row.version,
              installedAt: row.installed_at,
              tables: row.created_tables,
              sampleRecords: Object.values(row.sample_ids ?? {}).flat().length,
            }
          : null,
      };
    }),
    bundles: BUNDLES,
  });
}

// POST /apps/plan { apps, options }: what installing would do
export async function planHandler(req: Request, res: Response) {
  const { apps, options } = body(req);
  res.json(await plan(apps, options));
}

// POST /apps/install { apps, options }
export async function installHandler(req: Request, res: Response) {
  const { apps, options } = body(req);
  const result = await install(apps, options, currentUser(req));
  for (const key of result.apps) {
    await audit(req, {
      action: "install",
      entity: "app",
      recordId: key,
      changes: {
        tables: result.tables.filter((t) => t.key.startsWith(`${key}.`)).map((t) => t.tableName),
        sampleData: Boolean(options.sampleData),
      },
    });
  }
  res.json(result);
}

// DELETE /apps/:key: removes the tables the app created (and their records)
export async function uninstallHandler(req: Request, res: Response) {
  await loadDraftedApps();
  const key = param(req, "key");
  const result = await uninstall(key);
  await deleteUploads(result.removedFiles);
  await audit(req, { action: "uninstall", entity: "app", recordId: key, changes: { tables: result.removedTables } });
  res.json({ removedTables: result.removedTables });
}

// DELETE /apps/:key/sample: removes the sample records it added
export async function removeSampleHandler(req: Request, res: Response) {
  const key = param(req, "key");
  const result = await removeSample(key);
  await audit(req, { action: "delete", entity: "app", recordId: key, changes: { sampleRecords: result.removed } });
  res.json(result);
}

// GET /apps/dashboards (everyone): the Home page counts of the installed apps,
// only for tables this person can see. The numbers themselves come from the
// normal list endpoint, so they follow departments and "Own only".
export async function dashboardsHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const schemas = await getAllSchemas();
  const byKey = new Map(schemas.filter((s) => s.blueprintKey).map((s) => [s.blueprintKey!, s]));
  const visible = (app: AppBlueprint, key: string) => {
    const schema = byKey.get(fullKey(app, key));
    return schema && can(user, schema, "view") ? schema : null;
  };
  const hasColumns = (schema: TableSchema, names: string[]) => names.every((n) => schema.columns.some((c) => c.name === n));
  const out = [];
  for (const row of await listInstalled()) {
    const app = APP_BY_KEY.get(row.key);
    if (!app?.dashboard) continue;
    const tiles = app.dashboard.tiles.flatMap((t) => {
      const schema = visible(app, t.table);
      // a column the company removed: leave the tile out
      return schema && hasColumns(schema, (t.filters ?? []).map((f) => f.field))
        ? [{ label: t.label, table: schema.tableName, filters: t.filters ?? [] }]
        : [];
    });
    const b = app.dashboard.breakdown;
    const bSchema = b ? visible(app, b.table) : null;
    const bColumn = b && bSchema?.columns.find((c) => c.name === b.column && c.type === "choice" && !c.multiple);
    const breakdown =
      b && bSchema && bColumn
        ? { label: b.label, table: bSchema.tableName, column: bColumn.name, options: (bColumn.options ?? []).map((o) => o.label) }
        : null;
    if (tiles.length || breakdown) out.push({ app: app.key, name: app.name, icon: app.icon, tiles, breakdown });
  }
  res.json(out);
}

// POST /apps/draft { description }: Claude drafts an app for the organization
// described. Nothing is created: the answer goes to the normal preview.
export async function draftHandler(req: Request, res: Response) {
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : "";
  if (description.length < 10) throw new HttpError(400, "Describe your organization in a sentence or two");
  if (description.length > 2000) throw new HttpError(400, "Keep the description under 2,000 characters");
  const draft = await draftWithClaude(description);
  const app = fromDraft(draft);
  await audit(req, { action: "draft", entity: "app", recordId: app.key, changes: { description, tables: app.tables.map((t) => t.label) } });
  res.json({ draft, app: { key: app.key, name: app.name, description: app.description, tables: app.tables.map((t) => ({ key: t.key, label: t.label, description: t.description })) } });
}

