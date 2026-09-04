-- 0069 — Private thread title lifecycle.
-- chat_threads.title gains three columns so the server can own its
-- authority, distinguish AUTO (system-generated) from MANUAL (user-typed)
-- titles, remember the language authority that produced an AUTO title, and
-- record when the title was last written.
--
-- Backfill: three known placeholder strings (two hard-coded English strings
-- from the exploration/invitation paths, plus the client-side numbered
-- `新对话 N` / `New chat N` titles) are marked AUTO so the new
-- owner-triggered suggest path can replace them. Other historical rows
-- (if any) stay MANUAL — they were never user-named via the existing UI.
ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS title_source     varchar(16) NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS title_locale     varchar(8),
  ADD COLUMN IF NOT EXISTS title_updated_at timestamptz;

UPDATE chat_threads
   SET title_source = 'AUTO'
 WHERE title_source = 'MANUAL'
   AND (
     title IN ('Trip Planner', 'Personal trip scratchpad')
     OR title ~ '^新对话 [0-9]+$'
     OR title ~ '^New chat [0-9]+$'
   );

-- NOT VALID defers full-table validation; new writes are still constrained.
-- A follow-up migration will `VALIDATE CONSTRAINT` once the deployment is
-- stable (see docs/thread-title-lifecycle-implementation.md §14).
ALTER TABLE chat_threads
  ADD CONSTRAINT chat_threads_title_source_check
  CHECK (title_source IN ('AUTO', 'MANUAL')) NOT VALID;
