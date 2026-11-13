-- Several roles per person, and roles that belong to an app.
--
-- users.role_id stays the main role (Admin, a custom role, or "Member": no
-- rights of its own). user_roles holds the extra roles a person has, which
-- are normally app roles: "Projects · Manager", "HR & leave · Staff". A
-- person's rights are their roles' rights added up (see mergePermissions in
-- src/auth/access.ts).
CREATE TABLE IF NOT EXISTS user_roles (
  user_id  TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  role_id  TEXT NOT NULL REFERENCES roles(_id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role_id);

-- an app's roles: app_key = the app, app_level = "manager" / "staff"
ALTER TABLE roles ADD COLUMN IF NOT EXISTS app_key TEXT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS app_level TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS roles_app_level_key ON roles (app_key, app_level) WHERE app_key IS NOT NULL;

-- the main role for people whose rights come from their app access
INSERT INTO roles (name, description, permissions)
SELECT 'Member', 'No rights of its own: what they can do comes from their app access', '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE lower(name) = 'member');
