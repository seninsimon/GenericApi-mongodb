import express from "express";
import {
  createNewTable,
  getTables,
  getTableSchema,
  addColumnToTable,
  deleteColumnFromTable,
} from "../controller/schemaController.js";

const router = express.Router();

router.post("/schema", createNewTable);
router.get("/schema", getTables);
router.get("/schema/:table", getTableSchema);
router.post("/schema/:table/column", addColumnToTable);
router.delete("/schema/:table/column/:column", deleteColumnFromTable);

export default router;