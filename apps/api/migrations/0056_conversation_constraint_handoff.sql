-- 0056_conversation_constraint_handoff.sql
-- Member conversation candidate batch → Shared Agent handoff (spec §4.1)
-- 实施依据：docs/member-conversation-handoff-implementation.md §4.1, §5.2
--
-- Adds four columns to trip_constraint_proposals:
--   * batch_id          — groups the proposals produced by one conversation turn
--   * origin_thread_id  — the private chat_threads row that the proposals came from
--   * origin_run_id     — the agent_task_runs row that called the extraction skill
--   * candidate_version — monotonic; a later UI refresh must not silently overwrite
--                         a fresher set of candidates
--
-- 不变量：
--   * OWNER_FORM 行（遗留表单路径）必须没有 origin_thread_id/origin_run_id；
--   * PERSONAL_AGENT 行必须有 origin_thread_id + origin_run_id（来自对话抽取）；
--   * legacy 行（迁移前已存在的）允许 batch_id/origin_thread_id/origin_run_id 都为 NULL；
--   * candidate_version > 0；legacy 行默认 1。
--   * partial unique index 守护同一 batch 内 candidate_version 不重复。

ALTER TABLE trip_constraint_proposals
  ADD COLUMN IF NOT EXISTS batch_id UUID,
  ADD COLUMN IF NOT EXISTS origin_thread_id UUID REFERENCES chat_threads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origin_run_id UUID REFERENCES agent_task_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS candidate_version INTEGER NOT NULL DEFAULT 1;

-- legacy 行回填：source_kind 已是 OWNER_FORM，保持 origin_* 为 NULL；
-- candidate_version 已是 DEFAULT 1，无需处理。

-- candidate_version 必须为正整数
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trip_constraint_proposals_candidate_version_positive'
  ) THEN
    ALTER TABLE trip_constraint_proposals
      ADD CONSTRAINT trip_constraint_proposals_candidate_version_positive
      CHECK (candidate_version > 0);
  END IF;
END $$;

-- OWNER_FORM 与 origin_* 互斥；PERSONAL_AGENT 必须有 origin_thread_id/origin_run_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trip_constraint_proposals_origin_consistency'
  ) THEN
    ALTER TABLE trip_constraint_proposals
      ADD CONSTRAINT trip_constraint_proposals_origin_consistency
      CHECK (
        (source_kind = 'OWNER_FORM' AND origin_thread_id IS NULL AND origin_run_id IS NULL)
        OR
        (source_kind = 'PERSONAL_AGENT' AND origin_thread_id IS NOT NULL AND origin_run_id IS NOT NULL)
      );
  END IF;
END $$;

-- 同一 batch 内 candidate_version 不重复
CREATE UNIQUE INDEX IF NOT EXISTS trip_constraint_proposals_batch_version_unique
  ON trip_constraint_proposals (trip_id, batch_id, candidate_version)
  WHERE batch_id IS NOT NULL;

-- batch 查询索引（成员读取自己的 batch / 服务端按 batch 锁定）
CREATE INDEX IF NOT EXISTS trip_constraint_proposals_batch_idx
  ON trip_constraint_proposals (batch_id)
  WHERE batch_id IS NOT NULL;

-- origin_thread_id 反向索引（按 thread 找最近一个 batch）
CREATE INDEX IF NOT EXISTS trip_constraint_proposals_origin_thread_idx
  ON trip_constraint_proposals (origin_thread_id)
  WHERE origin_thread_id IS NOT NULL;

-- ─── audit_action enum 扩展 ───────────────────────────────────────────────
-- 三个新动作（docs/member-conversation-handoff-implementation.md §10）。
-- DO 块内 idempotent 检查，避免重复运行迁移时 ALTER TYPE 报错。
DO $$
DECLARE action TEXT;
BEGIN
  FOREACH action IN ARRAY ARRAY[
    'MEMBER_CONVERSATION_CANDIDATES_CREATED',
    'MEMBER_CONVERSATION_HANDOFF_CONFIRMED',
    'MEMBER_CONVERSATION_HANDOFF_REJECTED'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'audit_action' AND e.enumlabel = action
    ) THEN
      EXECUTE format('ALTER TYPE audit_action ADD VALUE %L', action);
    END IF;
  END LOOP;
END $$;
