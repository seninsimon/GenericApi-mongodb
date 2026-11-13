-- People's profile pictures (an uploaded image, "/uploads/<key>"; empty = initials).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '';
