DROP INDEX IF EXISTS one_active_dinner_per_organizer;
CREATE INDEX IF NOT EXISTS active_dinners_by_organizer ON dinners(organizer_id) WHERE ended_at IS NULL;
