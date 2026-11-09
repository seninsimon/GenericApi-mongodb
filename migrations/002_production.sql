-- Search, audit log, background jobs, shared login throttling.

-- Trigram indexes make "contains" search (ILIKE '%term%') fast.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- All values of a record as one searchable string (HTML tags stripped).
-- Used by a GIN trigram index on every data table.
CREATE OR REPLACE FUNCTION erp_search_text(doc jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(string_agg(regexp_replace(value, '<[^>]+>', ' ', 'g'), ' '), '')
  FROM jsonb_each_text(doc)
$$;

-- Numeric value of a text field, or NULL when it isn't a number.
-- Used for sorting / indexing number columns. Checks the format first instead
-- of catching a cast error: an EXCEPTION block is a subtransaction, which
-- Postgres doesn't allow inside parallel queries (used on big tables).
CREATE OR REPLACE FUNCTION erp_try_numeric(value text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF value ~ '^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d{1,3})?\s*$' THEN
    RETURN value::numeric;
  END IF;
  RETURN NULL;
END $$;

-- Who changed what, when. Kept even when the user is deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  _id         BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     TEXT,
  username    TEXT,
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  table_name  TEXT,
  record_id   TEXT,
  changes     JSONB,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_record_idx ON audit_log (table_name, record_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log (user_id, at DESC);

-- Background jobs (CSV import/export), processed by the worker.
CREATE TABLE IF NOT EXISTS jobs (
  _id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  table_name   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  username     TEXT NOT NULL,
  params       JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress     INTEGER NOT NULL DEFAULT 0,
  result       JSONB,
  error        TEXT,
  file_key     TEXT,
  file_name    TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs (user_id, created_at DESC);

-- Failed logins per IP+username, shared by all API instances.
CREATE TABLE IF NOT EXISTS login_attempts (
  key               TEXT PRIMARY KEY,
  failures          INTEGER NOT NULL,
  first_failure_at  TIMESTAMPTZ NOT NULL
);
