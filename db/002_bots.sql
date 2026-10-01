-- Bot sessions: the Agent SDK session id that carries a bot's context between
-- turns and across restarts. One per bot channel; deleting the bot drops it.
CREATE TABLE IF NOT EXISTS bot_sessions (
  channel_url TEXT PRIMARY KEY REFERENCES channels(channel_url) ON DELETE CASCADE,
  session_id  TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
