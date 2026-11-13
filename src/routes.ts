import { Router } from "express";
import * as admin from "./controllers/admin.js";
import { listAuditHandler } from "./controllers/audit.js";
import * as auth from "./controllers/auth.js";
import { uploadHandler } from "./controllers/files.js";
import { departmentOptionsHandler, userOptionsHandler } from "./controllers/people.js";
import * as jobs from "./controllers/jobs.js";
import * as records from "./controllers/records.js";
import * as apps from "./controllers/apps.js";
import * as email from "./controllers/email.js";
import * as ai from "./controllers/ai.js";
import * as chat from "./controllers/chat.js";
import * as comments from "./controllers/comments.js";
import * as notifications from "./controllers/notifications.js";
import * as schema from "./controllers/schema.js";
import { handle } from "./lib/http.js";
import { requireAdmin, requireAuth } from "./middleware/auth.js";
import { eventsHandler } from "./live/events.js";

// All /api routes. Record access is checked per table (role permissions +
// departments) inside the record/job controllers.
export const apiRouter = Router();
const r = apiRouter;
const adminOnly = [requireAuth, requireAdmin];

// ---- auth ----
r.post("/auth/login", handle(auth.login));
r.post("/auth/logout", handle(auth.logout));
r.get("/auth/me", requireAuth, handle(auth.me));
// live updates for this browser tab (Server-Sent Events)
r.get("/events", requireAuth, eventsHandler);
r.put("/auth/profile", requireAuth, handle(auth.updateProfile));
r.put("/auth/password", requireAuth, handle(auth.changePassword));
// "Forgot password?" and the "set your password" links from emails (no sign-in)
r.post("/auth/forgot", handle(auth.forgotPassword));
r.get("/auth/password-link", handle(auth.passwordLinkInfo));
r.post("/auth/set-password", handle(auth.setPasswordFromLink));

// ---- people picker (any logged-in user: names only) ----
r.get("/users/options", requireAuth, handle(userOptionsHandler));
r.get("/departments/options", requireAuth, handle(departmentOptionsHandler));

// ---- users / roles / departments (admin) ----
r.get("/users", adminOnly, handle(admin.getUsers));
r.get("/users/app-access", adminOnly, handle(admin.getAppAccessOptions));
r.post("/users", adminOnly, handle(admin.createUserHandler));
r.put("/users/:id", adminOnly, handle(admin.updateUserHandler));
r.delete("/users/:id", adminOnly, handle(admin.deleteUserHandler));
r.post("/users/:id/password-link", adminOnly, handle(admin.sendPasswordLinkHandler));

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
r.get("/schema/:table/automations", adminOnly, handle(notifications.listAutomationsHandler));
r.post("/schema/:table/automations", adminOnly, handle(notifications.createAutomationHandler));
r.put("/schema/:table/automations/:id", adminOnly, handle(notifications.updateAutomationHandler));
r.delete("/schema/:table/automations/:id", adminOnly, handle(notifications.deleteAutomationHandler));

// the bell: your own notifications
r.get("/notifications", requireAuth, handle(notifications.listNotificationsHandler));
r.post("/notifications/read", requireAuth, handle(notifications.readNotificationsHandler));

// team chat (workspace/CHAT_PLAN.md)
r.get("/chat", requireAuth, handle(chat.chatOverview));
r.get("/chat/settings", adminOnly, handle(chat.getChatSettingsHandler));
r.put("/chat/settings", adminOnly, handle(chat.saveChatSettingsHandler));
r.get("/chat/search", requireAuth, handle(chat.searchMessages));
r.post("/chat/dm", requireAuth, handle(chat.openDirect));
r.post("/chat/groups", requireAuth, handle(chat.createGroup));
r.put("/chat/messages/:message", requireAuth, handle(chat.editMessage));
r.delete("/chat/messages/:message", requireAuth, handle(chat.deleteMessage));
r.post("/chat/messages/:message/reactions", requireAuth, handle(chat.toggleReaction));
r.get("/chat/:channel/messages", requireAuth, handle(chat.listMessages));
r.post("/chat/:channel/messages", requireAuth, handle(chat.postMessage));
r.post("/chat/:channel/read", requireAuth, handle(chat.markRead));
r.delete("/chat/:channel/membership", requireAuth, handle(chat.leaveGroup));

// email: settings, test, the last emails (admin)
r.get("/email", adminOnly, handle(email.getEmailHandler));
r.put("/email", adminOnly, handle(email.saveEmailHandler));
r.post("/email/test", adminOnly, handle(email.testEmailHandler));

// AI: which provider drafts apps, and its key (admin)
r.get("/ai", adminOnly, handle(ai.getAiHandler));
r.put("/ai", adminOnly, handle(ai.saveAiHandler));
r.post("/ai/test", adminOnly, handle(ai.testAiHandler));

// apps (Projects, HR, ...): catalog, preview, install, remove
r.get("/apps", adminOnly, handle(apps.listAppsHandler));
r.get("/apps/dashboards", requireAuth, handle(apps.dashboardsHandler));
r.post("/apps/plan", adminOnly, handle(apps.planHandler));
r.post("/apps/draft", adminOnly, handle(apps.draftHandler));
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
// comments on a record (anyone who can see it)
r.get("/table/:collection/:id/comments", requireAuth, handle(comments.listComments));
r.post("/table/:collection/:id/comments", requireAuth, handle(comments.addComment));
r.put("/table/:collection/:id/comments/:commentId", requireAuth, handle(comments.editComment));
r.delete("/table/:collection/:id/comments/:commentId", requireAuth, handle(comments.deleteComment));
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
