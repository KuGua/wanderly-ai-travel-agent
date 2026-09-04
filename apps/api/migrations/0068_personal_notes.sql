-- 0068 — Owner-only Personal Note metadata.
-- These notes are deliberately not part of a constraint snapshot and never
-- cross the Personal Agent boundary.
ALTER TABLE free_text_memories
  ADD COLUMN IF NOT EXISTS title VARCHAR(80) NOT NULL DEFAULT 'Personal note',
  ADD COLUMN IF NOT EXISTS category VARCHAR(16) NOT NULL DEFAULT 'GENERAL',
  ADD COLUMN IF NOT EXISTS applies_to VARCHAR(16) NOT NULL DEFAULT 'ALL_TRIPS',
  ADD COLUMN IF NOT EXISTS trip_id UUID REFERENCES shared_trips(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS priority VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE free_text_memories
  DROP CONSTRAINT IF EXISTS free_text_memories_category_check,
  ADD CONSTRAINT free_text_memories_category_check CHECK (category IN ('GENERAL', 'FOOD', 'STAY', 'PACE', 'TRANSPORT', 'BUDGET', 'ACTIVITY')),
  DROP CONSTRAINT IF EXISTS free_text_memories_applies_to_check,
  ADD CONSTRAINT free_text_memories_applies_to_check CHECK (applies_to IN ('ALL_TRIPS', 'CURRENT_TRIP')),
  DROP CONSTRAINT IF EXISTS free_text_memories_priority_check,
  ADD CONSTRAINT free_text_memories_priority_check CHECK (priority IN ('PINNED', 'NORMAL')),
  DROP CONSTRAINT IF EXISTS free_text_memories_status_check,
  ADD CONSTRAINT free_text_memories_status_check CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  DROP CONSTRAINT IF EXISTS free_text_memories_trip_scope_check,
  ADD CONSTRAINT free_text_memories_trip_scope_check CHECK ((applies_to = 'ALL_TRIPS' AND trip_id IS NULL) OR (applies_to = 'CURRENT_TRIP' AND trip_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS free_text_memories_user_active_idx
  ON free_text_memories (user_id, status, priority, updated_at DESC);
