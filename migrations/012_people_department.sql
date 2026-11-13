-- The People directory's "Team" is a Department column: call it that, and
-- fill it in from the login's department when a login is picked (fromUser,
-- see src/schema/fromUser.ts). Only the app's own column, and only while it
-- still has the app's label: a column you renamed is left as it is.
UPDATE table_schemas s
SET columns = (
  SELECT jsonb_agg(
    CASE
      WHEN c->>'name' = 'team' AND c->>'type' = 'department' AND c->>'label' = 'Team'
        THEN c || '{"label": "Department", "fromUser": "account"}'::jsonb
      ELSE c
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(s.columns) WITH ORDINALITY AS e(c, ord)
),
updated_at = now()
WHERE s.blueprint_key = 'people.employees'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(s.columns) c
    WHERE c->>'name' = 'team' AND c->>'type' = 'department' AND c->>'label' = 'Team'
  );
