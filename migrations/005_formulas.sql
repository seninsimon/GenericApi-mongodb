-- Used by formula columns: a stored date value as a date, or NULL when it
-- isn't one. Checks the format instead of catching a cast error (an
-- EXCEPTION block isn't allowed inside parallel queries), like erp_try_numeric.
CREATE OR REPLACE FUNCTION erp_try_date(value text) RETURNS date
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  y int;
  m int;
  d int;
BEGIN
  IF value IS NULL OR value !~ '^\d{4}-\d{2}-\d{2}' THEN
    RETURN NULL;
  END IF;
  y := substr(value, 1, 4)::int;
  m := substr(value, 6, 2)::int;
  d := substr(value, 9, 2)::int;
  IF y < 1 OR m < 1 OR m > 12 OR d < 1
     OR d > extract(day FROM (make_date(y, m, 1) + interval '1 month - 1 day'))::int THEN
    RETURN NULL;
  END IF;
  RETURN make_date(y, m, d);
END $$;
