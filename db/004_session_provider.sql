-- Which provider ('anthropic' or 'ollama') created a bot's session. A session
-- is resumed only by that provider: an Ollama transcript carries thinking
-- blocks with empty signatures that the Anthropic API rejects, and a bot on
-- "default" changes provider when a key is added. NULL (a row written before
-- this column) is treated as unknown and not resumed.
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS provider TEXT;
