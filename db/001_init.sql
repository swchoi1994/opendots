-- Runs once, when the postgres volume is first created.
-- Re-run it with: docker compose down -v && docker compose up

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channels (
  channel_url   TEXT PRIMARY KEY,
  name          TEXT        NOT NULL,
  member_count  INTEGER     NOT NULL DEFAULT 0,
  is_frozen     BOOLEAN     NOT NULL DEFAULT FALSE,
  -- The assistant configuration is a nested, evolving shape; storing it as
  -- JSONB avoids a migration every time a field is added to the dialog.
  assistant     JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  message_id   BIGSERIAL PRIMARY KEY,
  channel_url  TEXT        NOT NULL REFERENCES channels(channel_url) ON DELETE CASCADE,
  sender_id    TEXT        NOT NULL,
  sender_name  TEXT        NOT NULL,
  body         TEXT        NOT NULL,
  message_type TEXT        NOT NULL DEFAULT 'user',
  provenance   JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Threads are always read newest-last for one channel, so index the pair.
CREATE INDEX IF NOT EXISTS messages_channel_created_idx
  ON messages (channel_url, created_at);

CREATE TABLE IF NOT EXISTS read_receipts (
  channel_url TEXT        NOT NULL REFERENCES channels(channel_url) ON DELETE CASCADE,
  user_id     TEXT        NOT NULL,
  read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_url, user_id)
);

-- ---------------------------------------------------------------------------
-- Skills and their embeddings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS skills (
  skill_id    TEXT PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  body        TEXT        NOT NULL,
  file_name   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per CHUNK, not per document: retrieval works on passages, and a
-- whole document is usually too coarse to be a useful match.
CREATE TABLE IF NOT EXISTS skill_chunks (
  chunk_id   BIGSERIAL PRIMARY KEY,
  skill_id   TEXT NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  -- 1536 matches text-embedding-3-small. Change the model, change this number
  -- AND rebuild the index — pgvector dimensions are fixed per column.
  embedding  vector(1536)
);

CREATE INDEX IF NOT EXISTS skill_chunks_skill_idx ON skill_chunks (skill_id);

-- Approximate-nearest-neighbour index for semantic search.
--   - vector_cosine_ops pairs with the `<=>` operator used in retrieve()'s
--     ORDER BY; mismatching the operator class makes Postgres ignore the index
--     and full-scan every row (verify with EXPLAIN ANALYZE).
--   - HNSW caps at 2000 dimensions, which is why embeddings are pinned to 1536
--     (see the future local-embeddings module, Phase 1b) even though a 3072-dim
--     model would otherwise fit the column.
-- Safe to create on an empty table; it simply fills as rows are ingested.
CREATE INDEX IF NOT EXISTS skill_chunks_embedding_idx
  ON skill_chunks USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Deployments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deployments (
  deployment_id TEXT PRIMARY KEY,
  channel_url   TEXT        NOT NULL REFERENCES channels(channel_url) ON DELETE CASCADE,
  passcode      TEXT        NOT NULL,
  allow_posting BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Deploying twice must return the same link, so a channel has at most one.
CREATE UNIQUE INDEX IF NOT EXISTS deployments_channel_idx
  ON deployments (channel_url);
