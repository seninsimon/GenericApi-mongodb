import express from "express";
import auth from "../middleware/auth.js";
import {
  addAddress,
  getMyAddresses,
  updateAddress,
  deleteAddress,
} from "../controller/address.controller.js";

const router = express.Router();

router.post("/add", auth, addAddress);
router.get("/my", auth, getMyAddresses);
router.put("/:id", auth, updateAddress);
router.delete("/:id", auth, deleteAddress);

export default router;