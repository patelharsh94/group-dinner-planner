CREATE TABLE reservation_reviews (
 id text PRIMARY KEY,
 dinner_id text NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
 version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 review jsonb NOT NULL,
 slot jsonb
);
CREATE INDEX reservation_reviews_dinner ON reservation_reviews(dinner_id,created_at DESC,id);
CREATE TABLE reservation_attempts (
 id text PRIMARY KEY,
 dinner_id text NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
 version integer NOT NULL,
 user_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 attempt jsonb NOT NULL,
 encrypted_contact text,
 slot jsonb
);
CREATE INDEX reservation_attempts_dinner ON reservation_attempts(dinner_id,created_at DESC,id);
-- Any unresolved or existing booking blocks another attempt even across proposal changes.
CREATE UNIQUE INDEX reservation_one_unresolved ON reservation_attempts(dinner_id)
 WHERE attempt->>'status' IN ('queued','submitting','booked','unknown','organizer_reported');
