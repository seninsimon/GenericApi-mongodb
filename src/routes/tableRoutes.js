import express from "express";
import { deleteTableData, getSingleTableData, getTableData, getTableOptions, insertTableData, updateTableData, updateTableSettings } from "../controller/tableController.js";

const router = express.Router();

router.get("/table/:collection", getTableData);
router.post("/table/:collection", insertTableData);
// must be registered before "/table/:collection/:id"
router.get("/table/:collection/options", getTableOptions);
router.put("/table/:collection/:id", updateTableData);
router.delete("/table/:collection/:id", deleteTableData);
router.get("/table/:collection/:id", getSingleTableData);
router.put("/schema/:table", updateTableSettings);

export default router;
