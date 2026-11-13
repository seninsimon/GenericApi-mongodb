-- "Who sees the records", per table:
--   by_department = true:  each department sees only its own records, and a
--                           person needs one of the table's departments to
--                           open it (the behaviour so far)
--   by_department = false: everyone whose role can use the table sees its
--                           records (roles and "Own only" still apply)
--
-- Every existing table keeps true, so nothing becomes visible that wasn't.
-- Apps installed from now on, and tables made in the app, use false.
ALTER TABLE table_schemas ADD COLUMN IF NOT EXISTS by_department BOOLEAN NOT NULL DEFAULT true;
