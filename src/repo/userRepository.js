import { createHash, randomBytes } from "crypto";
import { query, withTransaction } from "../config/db.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const hashToken = (token) => createHash("sha256").update(token).digest("hex");

// Shared SELECT for a user with role and departments
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

const toUser = (row) =>
  row && {
    _id: row._id,
    username: row.username,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    role: {
      _id: row.role_id,
      name: row.role_name,
      isAdmin: row.is_admin,
      permissions: row.permissions,
    },
    departments: row.departments,
  };

/* ---------------- sessions ---------------- */

export const createSession = async (userId) => {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(token), userId, expiresAt]
  );
  // housekeeping: drop this user's expired sessions
  await query(`DELETE FROM sessions WHERE user_id = $1 AND expires_at < now()`, [userId]);
  return { token, expiresAt };
};

// Returns { user, expiresAt } for a valid session of an active user, else null.
export const getSessionUser = async (token) => {
  const { rows } = await query(
    `SELECT x.*, s.expires_at AS session_expires_at
     FROM sessions s
     JOIN LATERAL (${USER_SELECT} WHERE u._id = s.user_id) x ON TRUE
     WHERE s.token_hash = $1 AND s.expires_at > now() AND x.is_active`,
    [hashToken(token)]
  );
  if (!rows[0]) return null;
  return { user: toUser(rows[0]), expiresAt: rows[0].session_expires_at };
};

export const extendSession = async (token) => {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(`UPDATE sessions SET expires_at = $2 WHERE token_hash = $1`, [
    hashToken(token),
    expiresAt,
  ]);
  return expiresAt;
};

export const deleteSession = (token) =>
  query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);

// Log a user out everywhere (optionally keeping the current session).
export const deleteUserSessions = (userId, exceptToken) =>
  exceptToken
    ? query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [
        userId,
        hashToken(exceptToken),
      ])
    : query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);

/* ---------------- users ---------------- */

export const findUserForLogin = async (username) => {
  const { rows } = await query(
    `SELECT _id, password_hash, is_active FROM users WHERE lower(username) = lower($1)`,
    [username]
  );
  return rows[0] ?? null;
};

export const getPasswordHash = async (userId) => {
  const { rows } = await query(`SELECT password_hash FROM users WHERE _id = $1`, [userId]);
  return rows[0]?.password_hash ?? null;
};

export const markLogin = (userId) =>
  query(`UPDATE users SET last_login_at = now() WHERE _id = $1`, [userId]);

export const getUserById = async (id) => {
  const { rows } = await query(`${USER_SELECT} WHERE u._id = $1`, [id]);
  return toUser(rows[0]) ?? null;
};

export const listUsers = async () => {
  const { rows } = await query(`${USER_SELECT} ORDER BY lower(u.username)`);
  return rows.map(toUser);
};

export const countUsers = async () => {
  const { rows } = await query(`SELECT count(*)::int AS n FROM users`);
  return rows[0].n;
};

// Active users with an admin role, optionally ignoring one user.
export const countActiveAdmins = async (exceptUserId = null) => {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM users u JOIN roles r ON r._id = u.role_id
     WHERE r.is_admin AND u.is_active AND ($1::text IS NULL OR u._id <> $1)`,
    [exceptUserId]
  );
  return rows[0].n;
};

const setUserDepartments = async (client, userId, departmentIds) => {
  await client.query(`DELETE FROM user_departments WHERE user_id = $1`, [userId]);
  if (departmentIds.length) {
    await client.query(
      `INSERT INTO user_departments (user_id, department_id)
       SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [userId, departmentIds]
    );
  }
};

export const createUser = async (data) => {
  const id = await withTransaction(async (client) => {
    const { rows } = await client.query(
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
      ]
    );
    await setUserDepartments(client, rows[0]._id, data.departmentIds ?? []);
    return rows[0]._id;
  });
  return getUserById(id);
};

// Only the keys present in `data` are changed.
export const updateUser = async (id, data) => {
  const fields = {
    username: "username",
    fullName: "full_name",
    email: "email",
    phone: "phone",
    passwordHash: "password_hash",
    roleId: "role_id",
    isActive: "is_active",
  };

  await withTransaction(async (client) => {
    const sets = [];
    const params = [id];
    for (const [key, column] of Object.entries(fields)) {
      if (data[key] === undefined) continue;
      params.push(data[key]);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length) {
      await client.query(
        `UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE _id = $1`,
        params
      );
    }
    if (data.departmentIds !== undefined) {
      await setUserDepartments(client, id, data.departmentIds);
    }
  });
  return getUserById(id);
};

export const deleteUser = async (id) => {
  const { rowCount } = await query(`DELETE FROM users WHERE _id = $1`, [id]);
  return rowCount > 0;
};

/* ---------------- roles ---------------- */

const toRole = (row) =>
  row && {
    _id: row._id,
    name: row.name,
    description: row.description,
    isAdmin: row.is_admin,
    permissions: row.permissions,
    userCount: row.user_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

const ROLE_SELECT = `
  SELECT r.*, (SELECT count(*)::int FROM users u WHERE u.role_id = r._id) AS user_count
  FROM roles r
`;

export const listRoles = async () => {
  const { rows } = await query(`${ROLE_SELECT} ORDER BY r.is_admin DESC, lower(r.name)`);
  return rows.map(toRole);
};

export const getRoleById = async (id) => {
  const { rows } = await query(`${ROLE_SELECT} WHERE r._id = $1`, [id]);
  return toRole(rows[0]) ?? null;
};

export const getAdminRole = async () => {
  const { rows } = await query(`${ROLE_SELECT} WHERE r.is_admin ORDER BY r.created_at LIMIT 1`);
  return toRole(rows[0]) ?? null;
};

export const createRole = async ({ name, description, permissions }) => {
  const { rows } = await query(
    `INSERT INTO roles (name, description, permissions) VALUES ($1, $2, $3::jsonb) RETURNING _id`,
    [name, description ?? "", JSON.stringify(permissions ?? {})]
  );
  return getRoleById(rows[0]._id);
};

export const updateRole = async (id, { name, description, permissions }) => {
  await query(
    `UPDATE roles SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       permissions = COALESCE($4::jsonb, permissions),
       updated_at = now()
     WHERE _id = $1`,
    [id, name ?? null, description ?? null, permissions ? JSON.stringify(permissions) : null]
  );
  return getRoleById(id);
};

export const deleteRole = async (id) => {
  const { rowCount } = await query(`DELETE FROM roles WHERE _id = $1 AND NOT is_admin`, [id]);
  return rowCount > 0;
};

/* ---------------- departments ---------------- */

const toDepartment = (row) =>
  row && {
    _id: row._id,
    name: row.name,
    description: row.description,
    userCount: row.user_count ?? 0,
    tableCount: row.table_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

const DEPARTMENT_SELECT = `
  SELECT d.*,
    (SELECT count(*)::int FROM user_departments ud WHERE ud.department_id = d._id) AS user_count,
    (SELECT count(*)::int FROM table_departments td WHERE td.department_id = d._id) AS table_count
  FROM departments d
`;

export const listDepartments = async () => {
  const { rows } = await query(`${DEPARTMENT_SELECT} ORDER BY lower(d.name)`);
  return rows.map(toDepartment);
};

export const getDepartmentById = async (id) => {
  const { rows } = await query(`${DEPARTMENT_SELECT} WHERE d._id = $1`, [id]);
  return toDepartment(rows[0]) ?? null;
};

// Which of `ids` exist (used to validate input).
export const existingDepartmentIds = async (ids) => {
  if (!ids.length) return [];
  const { rows } = await query(`SELECT _id FROM departments WHERE _id = ANY($1::text[])`, [ids]);
  return rows.map((r) => r._id);
};

export const createDepartment = async ({ name, description }) => {
  const { rows } = await query(
    `INSERT INTO departments (name, description) VALUES ($1, $2) RETURNING _id`,
    [name, description ?? ""]
  );
  return getDepartmentById(rows[0]._id);
};

export const updateDepartment = async (id, { name, description }) => {
  await query(
    `UPDATE departments SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       updated_at = now()
     WHERE _id = $1`,
    [id, name ?? null, description ?? null]
  );
  return getDepartmentById(id);
};

// Records of this department become unassigned (department_id -> NULL).
export const deleteDepartment = async (id) => {
  const { rowCount } = await query(`DELETE FROM departments WHERE _id = $1`, [id]);
  return rowCount > 0;
};
