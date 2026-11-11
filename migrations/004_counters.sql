-- Next number for "auto-number" columns (INV-0001, INV-0002, ...).
-- `period` is the year when the prefix contains {YYYY} (numbering restarts
-- each year), otherwise ''. Incremented inside the insert's transaction, so
-- numbers are unique; a rolled-back insert can leave a gap.
CREATE TABLE IF NOT EXISTS counters (
  table_name   TEXT NOT NULL REFERENCES table_schemas(table_name) ON DELETE CASCADE,
  column_name  TEXT NOT NULL,
  period       TEXT NOT NULL DEFAULT '',
  next         BIGINT NOT NULL,
  PRIMARY KEY (table_name, column_name, period)
);
