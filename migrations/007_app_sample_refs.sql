-- Named sample records per installed app (see 006_apps.sql, which has this
-- column for new databases). Databases that ran an earlier 006 get it here.
ALTER TABLE installed_apps ADD COLUMN IF NOT EXISTS sample_refs JSONB NOT NULL DEFAULT '{}'::jsonb;
