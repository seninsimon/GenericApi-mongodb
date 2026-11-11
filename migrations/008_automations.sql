-- In-app notifications (the bell): "Asha assigned you: …", automation messages.
CREATE TABLE IF NOT EXISTS notifications (
  _id          BIGSERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  table_name   TEXT,
  record_id    TEXT,
  actor        TEXT,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- Automations: "when Status becomes Approved -> set Approved on = today, notify …".
-- trigger: { when: "created" } | { when: "changed", column, to? }
-- actions: [{ do: "set", column, value } | { do: "notify", who, message? }]
CREATE TABLE IF NOT EXISTS automations (
  _id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  table_name  TEXT NOT NULL REFERENCES table_schemas(table_name) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  trigger     JSONB NOT NULL,
  actions     JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automations_table_idx ON automations (table_name);
