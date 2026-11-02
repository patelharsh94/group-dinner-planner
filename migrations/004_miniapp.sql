CREATE TABLE IF NOT EXISTS miniapp_receipts (
  user_id text NOT NULL,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  dinner_id text REFERENCES dinners(id) ON DELETE CASCADE,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id)
);

CREATE INDEX IF NOT EXISTS miniapp_receipts_dinner ON miniapp_receipts(dinner_id);
