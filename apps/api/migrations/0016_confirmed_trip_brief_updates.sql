ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_DRAFT_BRIEF_UPDATE';
ALTER TABLE shared_trips ADD COLUMN IF NOT EXISTS travel_days integer;
ALTER TABLE shared_trips ADD CONSTRAINT shared_trips_travel_days_range CHECK (travel_days IS NULL OR (travel_days >= 1 AND travel_days <= 365));
