CREATE TABLE IF NOT EXISTS reminder_limits (
  user_id text PRIMARY KEY,
  last_at timestamptz NOT NULL
);
