import type { Request, Response } from "express";
import { APPS, BUNDLES } from "../apps/index.js";
import { install, listInstalled, plan, removeSample, uninstall, type InstallOptions } from "../apps/installer.js";
import { HttpError, param } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import { deleteUploads } from "../storage.js";

// Settings -> Apps (admins only): the catalog, a preview of an install, and
// installing / removing apps.

const body = (req: Request) => {
  const { apps, options } = (req.body ?? {}) as { apps?: unknown; options?: InstallOptions };
  if (!Array.isArray(apps) || !apps.length || !apps.every((a) => typeof a === "string")) {
    throw new HttpError(400, "Choose an app to install");
  }
  return { apps: apps as string[], options: options ?? {} };
};

// GET /apps
export async function listAppsHandler(_req: Request, res: Response) {
  const installed = new Map((await listInstalled()).map((a) => [a.key, a]));
  res.json({
    apps: APPS.map((app) => {
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
