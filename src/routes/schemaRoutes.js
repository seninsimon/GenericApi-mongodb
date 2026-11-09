import express from "express";
import {
  createNewTable,
  getTables,
  getTableSchema,
  addColumnToTable,
  deleteColumnFromTable,
  updateColumn,
  deleteTable,
} from "../controller/schemaController.js";
import { handle } from "../controller/validation.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";

const router = express.Router();
const admin = [requireAuth, requireAdmin];

// reading schemas: any logged-in user (filtered to the tables they can access)
router.get("/schema", requireAuth, handle(getTables));
router.get("/schema/:table", requireAuth, handle(getTableSchema));

// changing schemas: admins only
router.post("/schema", admin, handle(createNewTable));
router.delete("/schema/:table", admin, handle(deleteTable));
router.post("/schema/:table/column", admin, handle(addColumnToTable));
router.delete("/schema/:table/column/:column", admin, handle(deleteColumnFromTable));
router.put("/schema/:table/column/:name", admin, handle(updateColumn));

export default router;
