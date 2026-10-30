CREATE TABLE IF NOT EXISTS dinners (
  id text PRIMARY KEY,
  organizer_id text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state jsonb NOT NULL,
  ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_dinner_per_organizer ON dinners (organizer_id) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS proposal_versions (
  dinner_id text NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dinner_id, version)
);
CREATE TABLE IF NOT EXISTS user_sessions (
  user_id text PRIMARY KEY,
  current_dinner_id text REFERENCES dinners(id) ON DELETE SET NULL,
  pending_setup jsonb,
  pending_onboard jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invitations (
  token_hash text PRIMARY KEY,
  dinner_id text NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS outbox (
  id text PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'message',
  subject_user_id text,
  dinner_id text REFERENCES dinners(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','ambiguous','failed','suppressed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(available_at) WHERE status='pending';
CREATE TABLE IF NOT EXISTS oauth_states (
  token_hash text PRIMARY KEY,
  dinner_id text NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_connections (
  dinner_id text NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  encrypted_token text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dinner_id,user_id)
);
