import type { Request, Response } from "express";
import { accessOf, accessOptions, rolesForAccess } from "../apps/access.js";
import { addToDirectory } from "../apps/directory.js";
import { normalizePermissions } from "../auth/access.js";
import { hashPassword, validateNewPassword } from "../auth/password.js";
import { isUniqueViolation } from "../db/pool.js";
import { cleanText, HttpError, isValidEmail, param, toIdList, USERNAME_PATTERN } from "../lib/http.js";
import { currentUser } from "../middleware/auth.js";
import { audit } from "../repo/auditRepo.js";
import type { CurrentUser } from "../types.js";
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
  type Role,
  type UserInput,
} from "../repo/userRepo.js";
import { invalidateSchemas } from "../schema/schemaRepo.js";

const conflict = (what: string) => (error: unknown) => {
  if (isUniqueViolation(error)) throw new HttpError(409, `${what} already exists`);
  throw error;
};

/* =============================== USERS =============================== */

async function readUserInput(body: Record<string, unknown>, creating: boolean) {
  const input: UserInput & { role?: Role } = {};

  if (creating || body.username !== undefined) {
    input.username = cleanText(body.username, 50);
    if (!USERNAME_PATTERN.test(input.username)) {
      throw new HttpError(400, "Username must be 3-50 characters: letters, numbers, dot, dash or underscore");
    }
  }
  if (body.fullName !== undefined) input.fullName = cleanText(body.fullName, 100);
  if (body.phone !== undefined) input.phone = cleanText(body.phone, 30);
  if (body.email !== undefined) {
    input.email = cleanText(body.email, 200);
    if (input.email && !isValidEmail(input.email)) throw new HttpError(400, "Invalid email address");
  }
  if (creating || body.password) {
    const problem = validateNewPassword(body.password);
    if (problem) throw new HttpError(400, problem);
    input.passwordHash = await hashPassword(String(body.password));
  }
  if (creating || body.roleId !== undefined) {
    const role = typeof body.roleId === "string" ? await getRoleById(body.roleId) : null;
    if (!role) throw new HttpError(400, "Please choose a valid role");
    input.role = role;
    input.roleId = role._id;
  }
  if (body.isActive !== undefined) input.isActive = Boolean(body.isActive);
  if (body.departmentIds !== undefined) {
    const ids = toIdList(body.departmentIds);
    if ((await existingDepartmentIds(ids)).length !== ids.length) throw new HttpError(400, "Unknown department selected");
    input.departmentIds = ids;
  }
  return input;
}

// fields worth recording in the audit log (never the password hash)
const auditableUser = (input: UserInput & { role?: Role }, appAccess?: unknown) => {
  const { passwordHash, role, extraRoleIds: _roles, ...rest } = input;
  return {
    ...rest,
    ...(role ? { role: role.name } : {}),
    ...(appAccess !== undefined ? { appAccess } : {}),
    ...(passwordHash ? { passwordReset: true } : {}),
  };
};

// a person as the API returns them: with their app access ({ projects: "manager" })
const withAccess = <T extends Pick<CurrentUser, "appRoles">>(user: T) => ({ ...user, appAccess: accessOf(user) });

export const getUsers = async (_req: Request, res: Response) => res.json((await listUsers()).map(withAccess));

// GET /users/app-access: the apps a person can be given access to, and their levels
export const getAppAccessOptions = async (_req: Request, res: Response) => res.json(await accessOptions());

export async function createUserHandler(req: Request, res: Response) {
  const body = req.body ?? {};
  const input = await readUserInput(body, true);
  if (body.appAccess !== undefined) input.extraRoleIds = await rolesForAccess([], body.appAccess);
  const user = await createUser(input as Parameters<typeof createUser>[0]).catch(conflict("A user with this username"));
  await audit(req, { action: "create", entity: "user", recordId: user._id, changes: auditableUser(input, body.appAccess) });
  // "Add person": their entry in the People directory too, linked to the login
  let directory: { table: string; id: string } | null = null;
  if (body.addToDirectory === true) {
    directory = await addToDirectory(user, currentUser(req));
    if (directory) {
      await audit(req, {
        action: "create",
        entity: "record",
        tableName: directory.table,
        recordId: directory.id,
        changes: { account: { to: user.fullName || user.username } },
      });
    }
  }
  res.status(201).json({ message: "User created", user: withAccess(user), directory });
}

export async function updateUserHandler(req: Request, res: Response) {
  const me = currentUser(req);
  const id = param(req, "id");
  const existing = await getUserById(id);
  if (!existing) throw new HttpError(404, "User not found");

  const input = await readUserInput(req.body ?? {}, false);
  if (req.body?.appAccess !== undefined) input.extraRoleIds = await rolesForAccess(existing.roleIds.slice(1), req.body.appAccess);
  const isSelf = id === me._id;
  const willBeAdmin = input.role ? input.role.isAdmin : existing.role.isAdmin;
  const willBeActive = input.isActive ?? existing.isActive;

  if (isSelf && !willBeActive) throw new HttpError(400, "You can't disable your own account");
  if (isSelf && !willBeAdmin) throw new HttpError(400, "You can't remove your own admin role");
  // never leave the system without an active admin
  if (existing.role.isAdmin && existing.isActive && !(willBeAdmin && willBeActive) && (await countActiveAdmins(id)) === 0) {
    throw new HttpError(400, "At least one active admin is required");
  }

  const user = await updateUser(id, input).catch(conflict("A user with this username"));
  // a reset password or disabled account signs the user out everywhere
  if (input.passwordHash || input.isActive === false) {
    await deleteUserSessions(id, isSelf ? req.sessionToken : undefined);
  }
  await audit(req, { action: "update", entity: "user", recordId: id, changes: auditableUser(input, req.body?.appAccess) });
  res.json({ message: "User updated", user: user && withAccess(user) });
}

export async function deleteUserHandler(req: Request, res: Response) {
  const id = param(req, "id");
  if (id === currentUser(req)._id) throw new HttpError(400, "You can't delete your own account");

  const existing = await getUserById(id);
  if (!existing) throw new HttpError(404, "User not found");
  if (existing.role.isAdmin && existing.isActive && (await countActiveAdmins(id)) === 0) {
    throw new HttpError(400, "At least one active admin is required");
  }

  await deleteUser(id);
  await audit(req, { action: "delete", entity: "user", recordId: id, changes: { username: existing.username } });
  res.json({ message: "User deleted" });
}

/* =============================== ROLES =============================== */

function readRoleInput(body: Record<string, unknown>, creating: boolean) {
  const input: { name?: string; description?: string; permissions?: ReturnType<typeof normalizePermissions> } = {};
  if (creating || body.name !== undefined) {
    input.name = cleanText(body.name, 60);
    if (!input.name) throw new HttpError(400, "Role name is required");
  }
  if (body.description !== undefined) input.description = cleanText(body.description, 300);
  if (body.permissions !== undefined) input.permissions = normalizePermissions(body.permissions);
  return input;
}

export const getRoles = async (_req: Request, res: Response) => res.json(await listRoles());

export async function createRoleHandler(req: Request, res: Response) {
  const input = readRoleInput(req.body ?? {}, true);
  const role = await createRole(input as { name: string }).catch(conflict("A role with this name"));
  await audit(req, { action: "create", entity: "role", recordId: role._id, changes: input });
  res.status(201).json({ message: "Role created", role });
}

export async function updateRoleHandler(req: Request, res: Response) {
  const existing = await getRoleById(param(req, "id"));
  if (!existing) throw new HttpError(404, "Role not found");

  const input = readRoleInput(req.body ?? {}, false);
  if (existing.isAdmin) delete input.permissions; // admins always have full access

  const role = await updateRole(existing._id, input).catch(conflict("A role with this name"));
  await audit(req, { action: "update", entity: "role", recordId: existing._id, changes: { name: existing.name, ...input } });
  res.json({ message: "Role updated", role });
}

export async function deleteRoleHandler(req: Request, res: Response) {
  const existing = await getRoleById(param(req, "id"));
  if (!existing) throw new HttpError(404, "Role not found");
  if (existing.isAdmin) throw new HttpError(400, "The Admin role can't be deleted");
  if (existing.appKey) throw new HttpError(400, "This role comes with an app: it's removed together with the app");
  if (existing.userCount > 0) {
    throw new HttpError(409, `This role is assigned to ${existing.userCount} user(s). Assign them another role first.`);
  }
  await deleteRole(existing._id);
  await audit(req, { action: "delete", entity: "role", recordId: existing._id, changes: { name: existing.name } });
  res.json({ message: "Role deleted" });
}

/* ============================ DEPARTMENTS ============================ */

function readDepartmentInput(body: Record<string, unknown>, creating: boolean) {
  const input: { name?: string; description?: string } = {};
  if (creating || body.name !== undefined) {
    input.name = cleanText(body.name, 80);
    if (!input.name) throw new HttpError(400, "Department name is required");
  }
  if (body.description !== undefined) input.description = cleanText(body.description, 300);
  return input;
}

export const getDepartments = async (_req: Request, res: Response) => res.json(await listDepartments());

export async function createDepartmentHandler(req: Request, res: Response) {
  const input = readDepartmentInput(req.body ?? {}, true);
  const department = await createDepartment(input as { name: string }).catch(conflict("A department with this name"));
  await audit(req, { action: "create", entity: "department", recordId: department._id, changes: input });
  res.status(201).json({ message: "Department created", department });
}

export async function updateDepartmentHandler(req: Request, res: Response) {
  const existing = await getDepartmentById(param(req, "id"));
  if (!existing) throw new HttpError(404, "Department not found");

  const input = readDepartmentInput(req.body ?? {}, false);
  const department = await updateDepartment(existing._id, input).catch(conflict("A department with this name"));
  await invalidateSchemas(); // table schemas include department names
  await audit(req, { action: "update", entity: "department", recordId: existing._id, changes: { name: existing.name, ...input } });
  res.json({ message: "Department updated", department });
}

export async function deleteDepartmentHandler(req: Request, res: Response) {
  const existing = await getDepartmentById(param(req, "id"));
  if (!existing) throw new HttpError(404, "Department not found");
  await deleteDepartment(existing._id);
  await invalidateSchemas();
  await audit(req, { action: "delete", entity: "department", recordId: existing._id, changes: { name: existing.name } });
  res.json({ message: "Department deleted" });
}
