-- Base schema: table definitions, departments, roles, users, sessions.
-- Written idempotently so it also applies to databases created by the
-- earlier start-up DDL.

CREATE TABLE IF NOT EXISTS table_schemas (
  _id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  table_name    TEXT NOT NULL UNIQUE,
  columns       JSONB NOT NULL DEFAULT '[]'::jsonb,
  show_in_menu  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User-defined ERP tables live in their own schema so they can never clash
-- with system tables. Tables created before this existed are moved here.
CREATE SCHEMA IF NOT EXISTS erp_data;

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT s.table_name FROM table_schemas s
    WHERE to_regclass(format('public.%I', s.table_name)) IS NOT NULL
      AND to_regclass(format('erp_data.%I', s.table_name)) IS NULL
  LOOP
    EXECUTE format('ALTER TABLE public.%I SET SCHEMA erp_data', t.table_name);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS departments (
  _id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS departments_name_key ON departments (lower(name));

-- permissions: { "<tableName>": { "view": bool, "create": bool, "edit": bool, "delete": bool } }
CREATE TABLE IF NOT EXISTS roles (
  _id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  is_admin     BOOLEAN NOT NULL DEFAULT FALSE,
  permissions  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_name_key ON roles (lower(name));

INSERT INTO roles (name, description, is_admin)
SELECT 'Admin', 'Full access to all tables and settings', TRUE
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE is_admin);

CREATE TABLE IF NOT EXISTS users (
  _id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  username       TEXT NOT NULL,
  full_name      TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  password_hash  TEXT NOT NULL,
  role_id        TEXT NOT NULL REFERENCES roles(_id) ON DELETE RESTRICT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));

CREATE TABLE IF NOT EXISTS user_departments (
  user_id        TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  department_id  TEXT NOT NULL REFERENCES departments(_id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, department_id)
);

CREATE TABLE IF NOT EXISTS table_departments (
  table_name     TEXT NOT NULL REFERENCES table_schemas(table_name) ON DELETE CASCADE,
  department_id  TEXT NOT NULL REFERENCES departments(_id) ON DELETE CASCADE,
  PRIMARY KEY (table_name, department_id)
);

-- token_hash = sha256 of the session cookie value
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
