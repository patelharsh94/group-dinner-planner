-- Transient directory payloads must never enter durable dinner/research JSON.
-- UNLOGGED avoids WAL replication; exclude this ephemeral table from backups.
CREATE UNLOGGED TABLE directory_business_cache (
  business_id text PRIMARY KEY CHECK (business_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  payload jsonb NOT NULL,
  retrieved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > retrieved_at AND expires_at <= retrieved_at + interval '23 hours')
);
CREATE INDEX directory_business_cache_expiry ON directory_business_cache(expires_at);
