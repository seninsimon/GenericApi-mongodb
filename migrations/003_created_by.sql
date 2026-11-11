-- "Created by" on every record: the user who created it.
--
-- Added to all existing data tables (new tables get it from ensureDataTable),
-- and filled in from the audit log for records created through the app.
-- Records from imports and seeds stay empty. No foreign key on purpose: when
-- a user account is deleted, its id stays and is shown as "Deleted user".
--
-- The index name must match ensureDataTable: left(md5(table name), 16) || '_createdby_idx'.
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
    EXECUTE format('ALTER TABLE erp_data.%I ADD COLUMN IF NOT EXISTS created_by TEXT', t.name);

    EXECUTE format(
      'UPDATE erp_data.%I AS r SET created_by = a.user_id
       FROM (
         SELECT DISTINCT ON (record_id) record_id, user_id
         FROM audit_log
         WHERE table_name = %L AND entity = ''record'' AND action = ''create''
           AND record_id IS NOT NULL AND user_id IS NOT NULL
         ORDER BY record_id, at
       ) AS a
       WHERE r._id = a.record_id AND r.created_by IS NULL',
      t.name, t.name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON erp_data.%I (created_by)',
      left(md5(t.name), 16) || '_createdby_idx', t.name
    );
  END LOOP;
END $$;
