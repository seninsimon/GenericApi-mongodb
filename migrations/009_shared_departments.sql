-- A record can be visible to several departments ("Visible to: Engineering,
-- Design"). department_id stays the first one (with its foreign key);
-- shared_department_ids holds the others. A user sees the record when any of
-- them is one of their departments for the table.
--
-- Added to all existing data tables (new tables get it from ensureDataTable).
-- Existing records keep their single department and share with nobody.
--
-- The index name must match ensureDataTable: left(md5(table name), 16) || '_shareddept_idx'.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'erp_data' AND c.relkind = 'r'
  LOOP
    EXECUTE format(
      'ALTER TABLE erp_data.%I ADD COLUMN IF NOT EXISTS shared_department_ids TEXT[] NOT NULL DEFAULT ''{}''',
      t.name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON erp_data.%I USING gin (shared_department_ids)',
      left(md5(t.name), 16) || '_shareddept_idx', t.name
    );
  END LOOP;
END $$;
