CREATE TABLE IF NOT EXISTS research_runs (
  id text PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  dinner_id text NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  input_version text NOT NULL,
  requested_at timestamptz NOT NULL,
  attempt jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS research_runs_latest ON research_runs(dinner_id, requested_at DESC, sequence DESC);
