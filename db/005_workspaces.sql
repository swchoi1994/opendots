-- Workspaces (sub-project B). Every channel and uploaded document belongs to
-- one: a Clerk organization id, a user's id for their personal workspace, or
-- 'local' when sign-in is off. Rows that predate this file stay in 'local'.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'local';
CREATE INDEX IF NOT EXISTS channels_workspace_idx ON channels (workspace_id);

ALTER TABLE skills ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'local';
CREATE INDEX IF NOT EXISTS skills_workspace_idx ON skills (workspace_id);

-- One-time, instance-wide decisions. `local_data` records who took over the
-- local workspace's data when sign-in was turned on, so it happens once.
CREATE TABLE IF NOT EXISTS instance_claims (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
