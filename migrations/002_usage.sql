CREATE TABLE IF NOT EXISTS usage_counts (
  scope text NOT NULL,
  subject_id text NOT NULL,
  day date NOT NULL,
  count integer NOT NULL CHECK(count >= 0),
  PRIMARY KEY(scope,subject_id,day)
);
