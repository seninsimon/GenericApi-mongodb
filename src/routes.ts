import { Router } from "express";
import * as admin from "./controllers/admin.js";
import { listAuditHandler } from "./controllers/audit.js";
import * as auth from "./controllers/auth.js";
import { uploadHandler } from "./controllers/files.js";
import { departmentOptionsHandler, userOptionsHandler } from "./controllers/people.js";
import * as jobs from "./controllers/jobs.js";
import * as records from "./controllers/records.js";
import * as apps from "./controllers/apps.js";
import * as schema from "./controllers/schema.js";
import { handle } from "./lib/http.js";
import { requireAdmin, requireAuth } from "./middleware/auth.js";

// All /api routes. Record access is checked per table (role permissions +
// departments) inside the record/job controllers.
export const apiRouter = Router();
const r = apiRouter;
const adminOnly = [requireAuth, requireAdmin];

// ---- auth ----
r.post("/auth/login", handle(auth.login));
r.post("/auth/logout", handle(auth.logout));
r.get("/auth/me", requireAuth, handle(auth.me));
r.put("/auth/profile", requireAuth, handle(auth.updateProfile));
r.put("/auth/password", requireAuth, handle(auth.changePassword));

// ---- people picker (any logged-in user: names only) ----
r.get("/users/options", requireAuth, handle(userOptionsHandler));
r.get("/departments/options", requireAuth, handle(departmentOptionsHandler));

// ---- users / roles / departments (admin) ----
r.get("/users", adminOnly, handle(admin.getUsers));
r.post("/users", adminOnly, handle(admin.createUserHandler));
r.put("/users/:id", adminOnly, handle(admin.updateUserHandler));
r.delete("/users/:id", adminOnly, handle(admin.deleteUserHandler));

r.get("/roles", adminOnly, handle(admin.getRoles));
r.post("/roles", adminOnly, handle(admin.createRoleHandler));
r.put("/roles/:id", adminOnly, handle(admin.updateRoleHandler));
r.delete("/roles/:id", adminOnly, handle(admin.deleteRoleHandler));

r.get("/departments", adminOnly, handle(admin.getDepartments));
r.post("/departments", adminOnly, handle(admin.createDepartmentHandler));
r.put("/departments/:id", adminOnly, handle(admin.updateDepartmentHandler));
r.delete("/departments/:id", adminOnly, handle(admin.deleteDepartmentHandler));

// ---- table schemas ----
r.get("/schema", requireAuth, handle(schema.getTables));
r.get("/schema/:table", requireAuth, handle(schema.getTableSchema));
r.post("/schema", adminOnly, handle(schema.createTableHandler));
r.put("/schema/:table", adminOnly, handle(schema.updateTableSettingsHandler));
r.delete("/schema/:table", adminOnly, handle(schema.deleteTableHandler));
r.put("/schema/:table/unassigned", adminOnly, handle(schema.assignUnassignedHandler));
r.post("/schema/:table/column", adminOnly, handle(schema.addColumnHandler));
r.put("/schema/:table/column/:name", adminOnly, handle(schema.updateColumnHandler));
r.delete("/schema/:table/column/:column", adminOnly, handle(schema.deleteColumnHandler));
r.post("/schema/:table/formula/check", adminOnly, handle(schema.checkFormulaHandler));

// apps (Projects, HR, ...): catalog, preview, install, remove
r.get("/apps", adminOnly, handle(apps.listAppsHandler));
r.post("/apps/plan", adminOnly, handle(apps.planHandler));
r.post("/apps/install", adminOnly, handle(apps.installHandler));
r.delete("/apps/:key", adminOnly, handle(apps.uninstallHandler));
r.delete("/apps/:key/sample", adminOnly, handle(apps.removeSampleHandler));

// ---- records ----
r.get("/table/:collection", requireAuth, handle(records.listHandler));
r.post("/table/:collection", requireAuth, handle(records.createHandler));
// these must come before "/table/:collection/:id"
r.get("/table/:collection/options", requireAuth, handle(records.optionsHandler));
r.post("/table/:collection/export", requireAuth, handle(jobs.startExportHandler));
r.post("/table/:collection/bulk-delete", requireAuth, handle(records.bulkDeleteHandler));
r.post("/table/:collection/import", requireAuth, handle(jobs.startImportHandler));
r.get("/table/:collection/:id", requireAuth, handle(records.getHandler));
r.put("/table/:collection/:id", requireAuth, handle(records.updateHandler));
r.delete("/table/:collection/:id", requireAuth, handle(records.deleteHandler));

// ---- files ----
r.post("/upload", requireAuth, handle(uploadHandler));

// ---- background jobs ----
r.get("/jobs", requireAuth, handle(jobs.listJobsHandler));
r.get("/jobs/:id", requireAuth, handle(jobs.getJobHandler));
r.get("/jobs/:id/download", requireAuth, handle(jobs.downloadJobHandler));

// ---- audit log ----
r.get("/audit", requireAuth, handle(listAuditHandler));
