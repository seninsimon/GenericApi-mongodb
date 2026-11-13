-- workspace/AI_FEATURES_PLAN.md: one row per AI request, for the usage and
-- cost figures in Administration → AI and for the limits. What was asked or
-- answered is never kept.
CREATE TABLE IF NOT EXISTS ai_usage (
  _id           BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  feature       TEXT NOT NULL,              -- draftApps, test, ...
  user_id       TEXT REFERENCES users(_id) ON DELETE SET NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  ok            BOOLEAN NOT NULL,
  cost_usd      NUMERIC(12, 6)              -- estimate; NULL when the model's price isn't known
);
CREATE INDEX IF NOT EXISTS ai_usage_created_idx ON ai_usage (created_at);
CREATE INDEX IF NOT EXISTS ai_usage_user_idx ON ai_usage (user_id, created_at);
