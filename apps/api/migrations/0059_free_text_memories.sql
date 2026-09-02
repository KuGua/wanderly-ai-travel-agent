-- 0059 — Free-text memories
--
-- The fallback for a highlight the catalogue cannot express. Long-term memory
-- is otherwise a closed set of typed fields, which is what makes it safe to
-- send to a model and safe to export under consent — but it means a traveller
-- can highlight something true and useful ("我在京都只想住町屋") and be told it
-- cannot be kept.
--
-- Kept apart from `preference_facts` rather than widened into it: these rows
-- have no field key, no schema to validate against, no supersession, and no
-- consent-export path. Sharing a table would have meant every reader of a
-- typed fact learning to skip rows that are not one.
--
-- Bounds live in the service, not here: at most 20 per traveller, and at most
-- 500 characters each, both reported to the person rather than truncated
-- silently. A row is deleted, never superseded — the traveller owns it.

CREATE TABLE IF NOT EXISTS free_text_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  -- Where it came from, for the traveller's own recall. Nullable and
  -- ON DELETE SET NULL: deleting a thread must not delete what it taught.
  source_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  source_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS free_text_memories_user_created_idx
  ON free_text_memories (user_id, created_at DESC);

-- ─── audit_action enum 扩展 ────────────────────────────────────────────────
-- The existence check names the schema this migration is writing to.
-- Unqualified, `WHERE t.typname = 'audit_action'` matches every schema that
-- has one, and this database has two — see the note in 0056, where that
-- oversight kept the handoff actions out of `public` entirely.
DO $$
DECLARE action TEXT;
BEGIN
  FOREACH action IN ARRAY ARRAY['FREE_TEXT_MEMORY_CREATE', 'FREE_TEXT_MEMORY_DELETE']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      WHERE e.enumtypid = 'audit_action'::regtype AND e.enumlabel = action
    ) THEN
      EXECUTE format('ALTER TYPE audit_action ADD VALUE %L', action);
    END IF;
  END LOOP;
END $$;
