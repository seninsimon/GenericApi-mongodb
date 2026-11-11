import type { Request, Response } from "express";
import { can, recordScope, isAdmin } from "../auth/access.js";
import { HttpError, intParam } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { listAudit } from "../repo/auditRepo.js";
import { getRecord } from "../repo/recordRepo.js";
import { getSchema } from "../schema/schemaRepo.js";

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

// GET /api/audit
// Admins: everything, with filters. Other users: only the history of one
// record they can view (tableName + recordId).
export async function listAuditHandler(req: Request, res: Response) {
  const user = currentUser(req);
  const filter = {
    tableName: str(req.query.tableName),
    recordId: str(req.query.recordId),
    userId: str(req.query.userId),
    action: str(req.query.action),
    entity: str(req.query.entity),
    from: str(req.query.from),
    to: str(req.query.to),
    page: intParam(req.query.page, 1, 1, 100_000),
    limit: intParam(req.query.limit, 25, 1, 100),
  };
  for (const date of [filter.from, filter.to]) {
    if (date && Number.isNaN(Date.parse(date))) throw new HttpError(400, "Invalid date filter");
  }

  if (!isAdmin(user)) {
    if (!filter.tableName || !filter.recordId) throw new HttpError(403, "Only admins can browse the audit log");
    const schema = await getSchema(filter.tableName);
    if (!schema || !can(user, schema, "view")) throw new HttpError(404, "Table not found");
    if (!(await getRecord(schema.tableName, filter.recordId, recordScope(user, schema)))) {
      throw new HttpError(404, "Record not found");
    }
    // record history only: no browsing by user or other entities
    Object.assign(filter, { userId: undefined, entity: "record" });
  }

  res.json(await listAudit(filter));
}
