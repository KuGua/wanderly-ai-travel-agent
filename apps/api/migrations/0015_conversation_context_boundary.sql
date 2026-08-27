-- PR 5 (same-thread LLM context memory):
  -- pin the upper `chat_messages.message_sequence` boundary for each
  -- `CONVERSATION` task at acceptance time so retries cannot include
  -- messages appended after the user pressed send.  PLAN/REPLAN tasks
  -- keep the column NULL.
  --
  -- See docs/thread-context-memory-implementation.md §4.1 and §10.

ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS context_max_message_sequence BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_task_runs_context_seq_positive'
  ) THEN
    ALTER TABLE agent_task_runs
      ADD CONSTRAINT agent_task_runs_context_seq_positive
      CHECK (context_max_message_sequence IS NULL OR context_max_message_sequence > 0);
  END IF;
END$$;

COMMENT ON COLUMN agent_task_runs.context_max_message_sequence IS
  'Upper message_sequence (chat_messages.message_sequence) the Worker may include when building this task''s same-thread LLM context.  Set at acceptance to the just-inserted USER row''s sequence; NULL for legacy rows (resolved at runtime, no backfill).  PLAN/REPLAN tasks keep NULL.';