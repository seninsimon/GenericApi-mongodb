import express from "express";
import {
  deleteTableData,
  getSingleTableData,
  getTableData,
  getTableOptions,
  insertTableData,
  updateTableData,
  updateTableSettings,
  assignUnassigned,
} from "../controller/tableController.js";
import { handle } from "../controller/validation.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";

const router = express.Router();

// record access is checked per table (role permissions + departments) in the controller
router.get("/table/:collection", requireAuth, handle(getTableData));
router.post("/table/:collection", requireAuth, handle(insertTableData));
// must be registered before "/table/:collection/:id"
router.get("/table/:collection/options", requireAuth, handle(getTableOptions));
router.put("/table/:collection/:id", requireAuth, handle(updateTableData));
router.delete("/table/:collection/:id", requireAuth, handle(deleteTableData));
router.get("/table/:collection/:id", requireAuth, handle(getSingleTableData));

// table settings (menu visibility, departments): admins only
router.put("/schema/:table", requireAuth, requireAdmin, handle(updateTableSettings));
router.put("/schema/:table/unassigned", requireAuth, requireAdmin, handle(assignUnassigned));

export default router;
