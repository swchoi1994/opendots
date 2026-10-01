-- Screen frames: one row per browser action a bot took, with the annotated
-- screenshot path in the bot's workspace. Deleting the bot drops them.
CREATE TABLE IF NOT EXISTS screens (
  screen_id   BIGSERIAL PRIMARY KEY,
  channel_url TEXT        NOT NULL REFERENCES channels(channel_url) ON DELETE CASCADE,
  turn_id     TEXT        NOT NULL,
  message_id  BIGINT,
  step        INTEGER     NOT NULL,
  action      TEXT        NOT NULL,
  target      TEXT,
  intent      TEXT,
  url         TEXT        NOT NULL DEFAULT '',
  title       TEXT        NOT NULL DEFAULT '',
  image_path  TEXT,
  annotations JSONB       NOT NULL DEFAULT '[]'::jsonb,
  flagged     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS screens_channel_created_idx ON screens (channel_url, created_at);
CREATE INDEX IF NOT EXISTS screens_turn_idx ON screens (channel_url, turn_id, step);
