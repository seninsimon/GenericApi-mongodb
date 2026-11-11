import { createHash, randomBytes } from "node:crypto";
import { query, withTransaction, type Db } from "../db/pool.js";
import type { CurrentUser, PermissionMap } from "../types.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// user + role + departments
const USER_SELECT = `
  SELECT u._id, u.username, u.full_name, u.email, u.phone, u.is_active,
         u.last_login_at, u.created_at, u.updated_at,
         r._id AS role_id, r.name AS role_name, r.is_admin, r.permissions,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object('_id', d._id, 'name', d.name) ORDER BY d.name)
           FROM user_departments ud JOIN departments d ON d._id = ud.department_id
           WHERE ud.user_id = u._id
         ), '[]'::jsonb) AS departments
  FROM users u
  JOIN roles r ON r._id = u.role_id
`;

type UserRow = {
  _id: string;
  username: string;
  full_name: string;
  email: string;
  phone: string;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  role_id: string;
  role_name: string;
  is_admin: boolean;
  permissions: PermissionMap;
  departments: { _id: string; name: string }[];
};

const toUser = (row: UserRow): CurrentUser => ({
  _id: row._id,
  username: row.username,
  fullName: row.full_name,
  email: row.email,
  phone: row.phone,
  isActive: row.is_active,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  role: { _id: row.role_id, name: row.role_name, isAdmin: row.is_admin, permissions: row.permissions },
  departments: row.departments,
});

/* ---------------- sessions ---------------- */

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [
    hashToken(token),
    userId,
    expiresAt,
  ]);
  await query(`DELETE FROM sessions WHERE user_id = $1 AND expires_at < now()`, [userId]);
  return { token, expiresAt };
}

// The user of a valid session (active users only), or null.
export async function getSessionUser(token: string) {
  const { rows } = await query<UserRow & { session_expires_at: Date }>(
    `SELECT x.*, s.expires_at AS session_expires_at
     FROM sessions s
     JOIN LATERAL (${USER_SELECT} WHERE u._id = s.user_id) x ON TRUE
     WHERE s.token_hash = $1 AND s.expires_at > now() AND x.is_active`,
    [hashToken(token)]
  );
  return rows[0] ? { user: toUser(rows[0]), expiresAt: rows[0].session_expires_at } : null;
}

export async function extendSession(token: string) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(`UPDATE sessions SET expires_at = $2 WHERE token_hash = $1`, [hashToken(token), expiresAt]);
  return expiresAt;
}

export const deleteSession = (token: string) =>
  query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);

// Log a user out everywhere (optionally keeping one session).
export const deleteUserSessions = (userId: string, exceptToken?: string) =>
  exceptToken
    ? query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [userId, hashToken(exceptToken)])
    : query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);

export const pruneSessions = () => query(`DELETE FROM sessions WHERE expires_at < now()`);

/* ---------------- users ---------------- */

export async function findUserForLogin(username: string) {
  const { rows } = await query<{ _id: string; username: string; password_hash: string; is_active: boolean }>(
    `SELECT _id, username, password_hash, is_active FROM users WHERE lower(username) = lower($1)`,
    [username]
  );
  return rows[0] ?? null;
}

export async function getPasswordHash(userId: string) {
  const { rows } = await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE _id = $1`, [userId]);
  return rows[0]?.password_hash ?? null;
}

export const markLogin = (userId: string) => query(`UPDATE users SET last_login_at = now() WHERE _id = $1`, [userId]);

export async function getUserById(id: string): Promise<CurrentUser | null> {
  const { rows } = await query<UserRow>(`${USER_SELECT} WHERE u._id = $1`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function listUsers(): Promise<CurrentUser[]> {
  const { rows } = await query<UserRow>(`${USER_SELECT} ORDER BY lower(u.username)`);
  return rows.map(toUser);
}

export async function countUsers() {
  const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  return rows[0].n;
}

// Active admins, optionally ignoring one user.
export async function countActiveAdmins(exceptUserId: string | null = null) {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users u JOIN roles r ON r._id = u.role_id
     WHERE r.is_admin AND u.is_active AND ($1::text IS NULL OR u._id <> $1)`,
    [exceptUserId]
  );
  return rows[0].n;
}

export interface UserInput {
  username?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  passwordHash?: string;
  roleId?: string;
  isActive?: boolean;
  departmentIds?: string[];
}

const setUserDepartments = async (db: Db, userId: string, departmentIds: string[]) => {
  await query(`DELETE FROM user_departments WHERE user_id = $1`, [userId], db);
  if (departmentIds.length) {
    await query(
      `INSERT INTO user_departments (user_id, department_id)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [userId, departmentIds],
      db
    );
  }
};

export async function createUser(data: UserInput & { username: string; passwordHash: string; roleId: string }) {
  const id = await withTransaction(async (client) => {
    const { rows } = await query<{ _id: string }>(
      `INSERT INTO users (username, full_name, email, phone, password_hash, role_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING _id`,
      [
        data.username,
        data.fullName ?? "",
        data.email ?? "",
        data.phone ?? "",
        data.passwordHash,
        data.roleId,
        data.isActive ?? true,
      ],
      client
    );
    await setUserDepartments(client, rows[0]._id, data.departmentIds ?? []);
    return rows[0]._id;
  });
  return (await getUserById(id))!;
}

// Only the keys present in `data` change.
export async function updateUser(id: string, data: UserInput) {
  const fields: [keyof UserInput, string][] = [
    ["username", "username"],
    ["fullName", "full_name"],
    ["email", "email"],
    ["phone", "phone"],
    ["passwordHash", "password_hash"],
    ["roleId", "role_id"],
    ["isActive", "is_active"],
  ];

  await withTransaction(async (client) => {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of fields) {
      if (data[key] === undefined) continue;
      params.push(data[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length) {
      await query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE _id = $1`, params, client);
    }
    if (data.departmentIds !== undefined) await setUserDepartments(client, id, data.departmentIds);
  });
  return getUserById(id);
}

export async function deleteUser(id: string) {
  const { rowCount } = await query(`DELETE FROM users WHERE _id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/* ---------------- roles ---------------- */

export interface Role {
  _id: string;
  name: string;
  description: string;
  isAdmin: boolean;
  permissions: PermissionMap;
  userCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type RoleRow = {
  _id: string;
  name: string;
  description: string;
  is_admin: boolean;
  permissions: PermissionMap;
  user_count: number;
  created_at: Date;
  updated_at: Date;
};

const toRole = (row: RoleRow): Role => ({
  _id: row._id,
  name: row.name,
  description: row.description,
  isAdmin: row.is_admin,
  permissions: row.permissions,
  userCount: row.user_count ?? 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const ROLE_SELECT = `
  SELECT r.*, (SELECT count(*)::int FROM users u WHERE u.role_id = r._id) AS user_count
  FROM roles r
`;

export async function listRoles() {
  const { rows } = await query<RoleRow>(`${ROLE_SELECT} ORDER BY r.is_admin DESC, lower(r.name)`);
  return rows.map(toRole);
}

export async function getRoleById(id: string) {
  const { rows } = await query<RoleRow>(`${ROLE_SELECT} WHERE r._id = $1`, [id]);
  return rows[0] ? toRole(rows[0]) : null;
}

export async function getAdminRole() {
  const { rows } = await query<RoleRow>(`${ROLE_SELECT} WHERE r.is_admin ORDER BY r.created_at LIMIT 1`);
  return rows[0] ? toRole(rows[0]) : null;
}

export async function createRole(input: { name: string; description?: string; permissions?: PermissionMap }) {
  const { rows } = await query<{ _id: string }>(
    `INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3::jsonb) RETURNING _id`,
    [input.name, input.description ?? "", JSON.stringify(input.permissions ?? {})]
  );
  return (await getRoleById(rows[0]._id))!;
}

export async function updateRole(id: string, input: { name?: string; description?: string; permissions?: PermissionMap }) {
  await query(
    `UPDATE roles SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       permissions = COALESCE($4::jsonb, permissions),
       updated_at = now()
     WHERE _id = $1`,
    [id, input.name ?? null, input.description ?? null, input.permissions ? JSON.stringify(input.permissions) : null]
  );
  return getRoleById(id);
}

export async function deleteRole(id: string) {
  const { rowCount } = await query(`DELETE FROM roles WHERE _id = $1 AND NOT is_admin`, [id]);
  return (rowCount ?? 0) > 0;
}

// When a table is deleted, drop its permission entries from every role.
export const removeTableFromRoles = (tableName: string, db?: Db) =>
  query(`UPDATE roles SET permissions = permissions - $1::text WHERE permissions ? $1`, [tableName], db);

/* ---------------- departments ---------------- */

export interface Department {
  _id: string;
  name: string;
  description: string;
  userCount: number;
  tableCount: number;
  createdAt: Date;
  updatedAt: Date;
}

type DepartmentRow = {
  _id: string;
  name: string;
  description: string;
  user_count: number;
  table_count: number;
  created_at: Date;
  updated_at: Date;
};

const toDepartment = (row: DepartmentRow): Department => ({
  _id: row._id,
  name: row.name,
  description: row.description,
  userCount: row.user_count ?? 0,
  tableCount: row.table_count ?? 0,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const DEPARTMENT_SELECT = `
  SELECT d.*,
    (SELECT count(*)::int FROM user_departments ud WHERE ud.department_id = d._id) AS user_count,
    (SELECT count(*)::int FROM table_departments td WHERE td.department_id = d._id) AS table_count
  FROM departments d
`;

export async function listDepartments() {
  const { rows } = await query<DepartmentRow>(`${DEPARTMENT_SELECT} ORDER BY lower(d.name)`);
  return rows.map(toDepartment);
}

export async function getDepartmentById(id: string) {
  const { rows } = await query<DepartmentRow>(`${DEPARTMENT_SELECT} WHERE d._id = $1`, [id]);
  return rows[0] ? toDepartment(rows[0]) : null;
}

export async function existingDepartmentIds(ids: string[]) {
  if (!ids.length) return [];
  const { rows } = await query<{ _id: string }>(`SELECT _id FROM departments WHERE _id = ANY($1::text[])`, [ids]);
  return rows.map((r) => r._id);
}

export async function createDepartment(input: { name: string; description?: string }) {
  const { rows } = await query<{ _id: string }>(
    `INSERT INTO departments (name, description) VALUES ($1, $2) RETURNING _id`,
    [input.name, input.description ?? ""]
  );
  return (await getDepartmentById(rows[0]._id))!;
}

export async function updateDepartment(id: string, input: { name?: string; description?: string }) {
  await query(
    `UPDATE departments SET
       name = COALESCE($2, name), description = COALESCE($3, description), updated_at = now()
     WHERE _id = $1`,
    [id, input.name ?? null, input.description ?? null]
  );
  return getDepartmentById(id);
}

// Records of this department become unassigned (department_id -> NULL).
export async function deleteDepartment(id: string) {
  const { rowCount } = await query(`DELETE FROM departments WHERE _id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/* ---------------- people pickers ("User" columns, "Created by") ---------------- */

export interface UserOption {
  value: string;
  label: string;
  username: string;
  isActive: boolean;
}

const OPTION_SELECT = `SELECT _id, username, full_name, is_active FROM users`;
type OptionRow = { _id: string; username: string; full_name: string; is_active: boolean };
const toOption = (r: OptionRow): UserOption => ({
  value: r._id,
  label: r.full_name.trim() || r.username,
  username: r.username,
  isActive: r.is_active,
});

// Names for user ids (any status, so old values keep showing). Missing ids = deleted users.
export async function getUserOptionsByIds(ids: string[]): Promise<Map<string, UserOption>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { rows } = await query<OptionRow>(`${OPTION_SELECT} WHERE _id = ANY($1::text[])`, [unique]);
  return new Map(rows.map((r) => [r._id, toOption(r)]));
}

// Active users matching `search` (name or username), for pickers.
export async function searchUserOptions(search: string, limit: number): Promise<UserOption[]> {
  const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await query<OptionRow>(
    `${OPTION_SELECT}
     WHERE is_active AND ($1 = '%%' OR full_name ILIKE $1 OR username ILIKE $1)
     ORDER BY lower(coalesce(nullif(trim(full_name), ''), username))
     LIMIT $2`,
    [pattern, limit]
  );
  return rows.map(toOption);
}

// Active users whose id, username or full name (case-insensitive) is one of `values` (imports).
export async function findActiveUsers(values: string[]): Promise<UserOption[]> {
  const unique = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (!unique.length) return [];
  const lower = unique.map((v) => v.toLowerCase());
  const { rows } = await query<OptionRow>(
    `${OPTION_SELECT}
     WHERE is_active AND (_id = ANY($1::text[]) OR lower(username) = ANY($2::text[]) OR lower(trim(full_name)) = ANY($2::text[]))`,
    [unique, lower]
  );
  return rows.map(toOption);
}

// Display name for a user id from getUserOptionsByIds ("" for no id).
export const userLabel = (options: Map<string, UserOption>, id: unknown): string =>
  id ? (options.get(String(id))?.label ?? "Deleted user") : "";
