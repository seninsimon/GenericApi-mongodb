-- Email (see workspace/EMAIL_PLAN.md):
--   email_outbox     emails waiting to be sent, sent, or failed; written in the
--                    same transaction as the change that caused them, sent by
--                    the worker (with retries)
--   users.email_pref "Email me": now (right away) | daily (in the morning
--                    summary) | never
--   notifications.digest_pending  waiting for the morning summary (daily people)
--   password_tokens  "set your password" links: invite (welcome) or reset
--                    (forgot password); only a hash of the token is stored
--   app_state        small facts like the last morning summary's date
CREATE TABLE IF NOT EXISTS email_outbox (
  _id              BIGSERIAL PRIMARY KEY,
  user_id          TEXT REFERENCES users(_id) ON DELETE SET NULL,
  to_address       TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'notification',
  subject          TEXT NOT NULL,
  text_body        TEXT NOT NULL,
  html_body        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS email_outbox_created_idx ON email_outbox (created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_pref TEXT NOT NULL DEFAULT 'now';

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS digest_pending BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS notifications_digest_idx ON notifications (user_id) WHERE digest_pending;

CREATE TABLE IF NOT EXISTS password_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  purpose      TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_tokens_user_idx ON password_tokens (user_id);

CREATE TABLE IF NOT EXISTS app_state (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
