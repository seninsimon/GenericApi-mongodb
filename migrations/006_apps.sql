-- Installable apps (Projects, HR, CRM, ...): see src/apps/.
--
-- blueprint_key: which app table a table is ("projects.tasks"). It survives
-- renames and column edits, and is how a later app finds and links to tables
-- an earlier app created. app_key: the app it came with (sidebar groups).
ALTER TABLE table_schemas ADD COLUMN IF NOT EXISTS blueprint_key TEXT;
ALTER TABLE table_schemas ADD COLUMN IF NOT EXISTS app_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS table_schemas_blueprint_key_key
  ON table_schemas (blueprint_key) WHERE blueprint_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS installed_apps (
  key           TEXT PRIMARY KEY,
  version       INT NOT NULL,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by  TEXT,
  -- what was chosen in the preview (tables, departments, sample data)
  options       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- sample records it added: { "<table name>": ["<id>", ...] }
  sample_ids    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- tables it created (only these can be removed with the app)
  created_tables TEXT[] NOT NULL DEFAULT '{}',
  -- named sample records ("people.employees:asha" -> id), so sample records
  -- of apps installed later can link to them
  sample_refs   JSONB NOT NULL DEFAULT '{}'::jsonb
);
