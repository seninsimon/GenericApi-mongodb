import express from "express";
import {
  changePassword,
  login,
  logout,
  me,
  updateProfile,
} from "../controller/authController.js";
import {
  createDepartmentHandler,
  createRoleHandler,
  createUserHandler,
  deleteDepartmentHandler,
  deleteRoleHandler,
  deleteUserHandler,
  getDepartments,
  getRoles,
  getUsers,
  updateDepartmentHandler,
  updateRoleHandler,
  updateUserHandler,
} from "../controller/adminController.js";
import { handle } from "../controller/validation.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";

const router = express.Router();

// ---- auth (public: login/logout) ----
router.post("/auth/login", handle(login));
router.post("/auth/logout", handle(logout));

// ---- current user ----
router.get("/auth/me", requireAuth, handle(me));
router.put("/auth/profile", requireAuth, handle(updateProfile));
router.put("/auth/password", requireAuth, handle(changePassword));

// ---- admin: users / roles / departments ----
const admin = [requireAuth, requireAdmin];

router.get("/users", admin, handle(getUsers));
router.post("/users", admin, handle(createUserHandler));
router.put("/users/:id", admin, handle(updateUserHandler));
router.delete("/users/:id", admin, handle(deleteUserHandler));

router.get("/roles", admin, handle(getRoles));
router.post("/roles", admin, handle(createRoleHandler));
router.put("/roles/:id", admin, handle(updateRoleHandler));
router.delete("/roles/:id", admin, handle(deleteRoleHandler));

// (users see their own departments via /auth/me and per table via /schema)
router.get("/departments", admin, handle(getDepartments));
router.post("/departments", admin, handle(createDepartmentHandler));
router.put("/departments/:id", admin, handle(updateDepartmentHandler));
router.delete("/departments/:id", admin, handle(deleteDepartmentHandler));

export default router;
