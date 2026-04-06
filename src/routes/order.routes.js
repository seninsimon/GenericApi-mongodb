import express from "express";
import auth from "../middleware/auth.js";
import { createOrder, getMyOrders } from "../controller/order.controller.js";

const router = express.Router();

router.post("/create", auth, createOrder);
router.get("/my", auth, getMyOrders);

export default router;