import express from "express";
import { deleteTableData, getTableData, insertTableData, updateTableData } from "../controller/tableController.js";

const router = express.Router();

router.get("/table/:collection", getTableData);

router.post("/table/:collection", insertTableData);

router.put("/table/:collection/:id", updateTableData);
router.delete("/table/:collection/:id", deleteTableData);


export default router;