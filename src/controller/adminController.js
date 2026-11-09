import { normalizePermissions } from "../auth/access.js";
import { hashPassword, validateNewPassword } from "../auth/password.js";
import { isUniqueViolation } from "../config/db.js";
import {
  countActiveAdmins,
  createDepartment,
  createRole,
  createUser,
  deleteDepartment,
  deleteRole,
  deleteUser,
  deleteUserSessions,
  existingDepartmentIds,
  getDepartmentById,
  getRoleById,
  getUserById,
  listDepartments,
  listRoles,
  listUsers,
  updateDepartment,
  updateRole,
  updateUser,
} from "../repo/userRepository.js";
import {
  cleanText,
  HttpError,
  isValidEmail,
  toIdList,
  USERNAME_PATTERN,
} from "./validation.js";

const conflictOnDuplicate = (what) => (error) => {
  if (isUniqueViolation(error)) throw new HttpError(409, `${what} already exists`);
  throw error;
};

/* =============================== USERS =============================== */

const validateDepartments = async (ids) => {
  const found = await existingDepartmentIds(ids);
  if (found.length !== ids.length) throw new HttpError(400, "Unknown department selected");
  return ids;
};

const validateRole = async (roleId) => {
  const role = roleId ? await getRoleById(roleId) : null;
  if (!role) throw new HttpError(400, "Please choose a valid role");
  return role;
};

// Shared validation for create/update; only keys present in body are returned.
const readUserInput = async (body, { creating }) => {
  const input = {};

  if (creating || body.username !== undefined) {
    input.username = cleanText(body.username, 50);
    if (!USERNAME_PATTERN.test(input.username)) {
      throw new HttpError(
        400,
        "Username must be 3-50 characters: letters, numbers, dot, dash or underscore"
      );
    }
  }
  if (body.fullName !== undefined) input.fullName = cleanText(body.fullName, 100);
  if (body.phone !== undefined) input.phone = cleanText(body.phone, 30);
  if (body.email !== undefined) {
    input.email = cleanText(body.email, 200);
    if (input.email && !isValidEmail(input.email)) {
      throw new HttpError(400, "Invalid email address");
    }
  }
  if (creating || body.password) {
    const problem = validateNewPassword(body.password);
    if (problem) throw new HttpError(400, problem);
    input.passwordHash = await hashPassword(body.password);
  }
  if (creating || body.roleId !== undefined) {
    input.role = await validateRole(body.roleId);
    input.roleId = input.role._id;
  }
  if (body.isActive !== undefined) input.isActive = Boolean(body.isActive);
  if (body.departmentIds !== undefined) {
    input.departmentIds = await validateDepartments(toIdList(body.departmentIds));
  }
  return input;
};

export const getUsers = async (req, res) => {
  res.json(await listUsers());
};

export const createUserHandler = async (req, res) => {
  const input = await readUserInput(req.body ?? {}, { creating: true });
  const user = await createUser(input).catch(conflictOnDuplicate("A user with this username"));
  res.status(201).json({ message: "User created", user });
};

export const updateUserHandler = async (req, res) => {
  const { id } = req.params;
  const existing = await getUserById(id);
  if (!existing) throw new HttpError(404, "User not found");

  const input = await readUserInput(req.body ?? {}, { creating: false });
  const isSelf = id === req.user._id;

  const willBeAdmin = input.role ? input.role.isAdmin : existing.role.isAdmin;
  const willBeActive = input.isActive ?? existing.isActive;

  if (isSelf && !willBeActive) throw new HttpError(400, "You can't disable your own account");
  if (isSelf && !willBeAdmin) throw new HttpError(400, "You can't remove your own admin role");

  // never leave the system without an active admin
  if (existing.role.isAdmin && existing.isActive && !(willBeAdmin && willBeActive)) {
    if ((await countActiveAdmins(id)) === 0) {
      throw new HttpError(400, "At least one active admin is required");
    }
  }

  const user = await updateUser(id, input).catch(conflictOnDuplicate("A user with this username"));

  // a reset password or disabled account signs the user out everywhere
  if (input.passwordHash || input.isActive === false) {
    await deleteUserSessions(id, isSelf ? req.sessionToken : undefined);
  }

  res.json({ message: "User updated", user });
};

export const deleteUserHandler = async (req, res) => {
  const { id } = req.params;
  if (id === req.user._id) throw new HttpError(400, "You can't delete your own account");

  const existing = await getUserById(id);
  if (!existing) throw new HttpError(404, "User not found");

  if (existing.role.isAdmin && existing.isActive && (await countActiveAdmins(id)) === 0) {
    throw new HttpError(400, "At least one active admin is required");
  }

  await deleteUser(id);
  res.json({ message: "User deleted" });
};

/* =============================== ROLES =============================== */

const readRoleInput = (body, { creating }) => {
  const input = {};
  if (creating || body.name !== undefined) {
    input.name = cleanText(body.name, 60);
    if (!input.name) throw new HttpError(400, "Role name is required");
  }
  if (body.description !== undefined) input.description = cleanText(body.description, 300);
  if (body.permissions !== undefined) input.permissions = normalizePermissions(body.permissions);
  return input;
};

export const getRoles = async (req, res) => {
  res.json(await listRoles());
};

export const createRoleHandler = async (req, res) => {
  const role = await createRole(readRoleInput(req.body ?? {}, { creating: true })).catch(
    conflictOnDuplicate("A role with this name")
  );
  res.status(201).json({ message: "Role created", role });
};

export const updateRoleHandler = async (req, res) => {
  const existing = await getRoleById(req.params.id);
  if (!existing) throw new HttpError(404, "Role not found");

  const input = readRoleInput(req.body ?? {}, { creating: false });
  // the Admin role always has full access; its permission map is unused
  if (existing.isAdmin) delete input.permissions;

  const role = await updateRole(existing._id, input).catch(
    conflictOnDuplicate("A role with this name")
  );
  res.json({ message: "Role updated", role });
};

export const deleteRoleHandler = async (req, res) => {
  const existing = await getRoleById(req.params.id);
  if (!existing) throw new HttpError(404, "Role not found");
  if (existing.isAdmin) throw new HttpError(400, "The Admin role can't be deleted");
  if (existing.userCount > 0) {
    throw new HttpError(
      409,
      `This role is assigned to ${existing.userCount} user(s). Assign them another role first.`
    );
  }

  await deleteRole(existing._id);
  res.json({ message: "Role deleted" });
};

/* ============================ DEPARTMENTS ============================ */

const readDepartmentInput = (body, { creating }) => {
  const input = {};
  if (creating || body.name !== undefined) {
    input.name = cleanText(body.name, 80);
    if (!input.name) throw new HttpError(400, "Department name is required");
  }
  if (body.description !== undefined) input.description = cleanText(body.description, 300);
  return input;
};

export const getDepartments = async (req, res) => {
  res.json(await listDepartments());
};

export const createDepartmentHandler = async (req, res) => {
  const department = await createDepartment(
    readDepartmentInput(req.body ?? {}, { creating: true })
  ).catch(conflictOnDuplicate("A department with this name"));
  res.status(201).json({ message: "Department created", department });
};

export const updateDepartmentHandler = async (req, res) => {
  const existing = await getDepartmentById(req.params.id);
  if (!existing) throw new HttpError(404, "Department not found");

  const department = await updateDepartment(
    existing._id,
    readDepartmentInput(req.body ?? {}, { creating: false })
  ).catch(conflictOnDuplicate("A department with this name"));
  res.json({ message: "Department updated", department });
};

export const deleteDepartmentHandler = async (req, res) => {
  const deleted = await deleteDepartment(req.params.id);
  if (!deleted) throw new HttpError(404, "Department not found");
  res.json({ message: "Department deleted" });
};
