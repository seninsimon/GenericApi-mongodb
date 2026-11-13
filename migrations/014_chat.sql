-- Comments on records, and team chat (workspace/CHAT_PLAN.md).

-- a record's comments ("@Sam can you attach the certificate?")
CREATE TABLE IF NOT EXISTS comments (
  _id         BIGSERIAL PRIMARY KEY,
  table_name  TEXT NOT NULL REFERENCES table_schemas(table_name) ON DELETE CASCADE,
  record_id   TEXT NOT NULL,
  user_id     TEXT REFERENCES users(_id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  mentions    TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS comments_record_idx ON comments (table_name, record_id, _id);

-- channels: everyone (one), department (one per department, members follow
-- the department), group (named, chosen members), dm (two people)
CREATE TABLE IF NOT EXISTS chat_channels (
  _id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  department_id  TEXT REFERENCES departments(_id) ON DELETE CASCADE,
  dm_key         TEXT UNIQUE, -- "userA:userB" (sorted): one DM per pair
  created_by     TEXT REFERENCES users(_id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_channels_everyone_key ON chat_channels (kind) WHERE kind = 'everyone';
CREATE UNIQUE INDEX IF NOT EXISTS chat_channels_department_key ON chat_channels (department_id) WHERE kind = 'department';

-- members of groups and DMs (everyone and department channels work them out)
CREATE TABLE IF NOT EXISTS chat_members (
  channel_id  TEXT NOT NULL REFERENCES chat_channels(_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user_idx ON chat_members (user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  _id          BIGSERIAL PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES chat_channels(_id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(_id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'text', -- text | call
  body         TEXT NOT NULL DEFAULT '',
  mentions     TEXT[] NOT NULL DEFAULT '{}',
  attachments  JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{ url, name }]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at    TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages (channel_id, _id DESC);
CREATE INDEX IF NOT EXISTS chat_messages_mentions_idx ON chat_messages USING gin (mentions);

CREATE TABLE IF NOT EXISTS chat_reactions (
  message_id  BIGINT NOT NULL REFERENCES chat_messages(_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- how far each person has read in each channel
CREATE TABLE IF NOT EXISTS chat_reads (
  channel_id    TEXT NOT NULL REFERENCES chat_channels(_id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  last_read_id  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);
