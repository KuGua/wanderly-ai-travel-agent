-- 0047a — Phase 1 of DRAFT Personal Research
-- Add the `PERSONAL_RESEARCH` value to the `agent_task_operation` enum, and
-- the new `audit_action` values for owner-only Personal Research lifecycle.
--
-- MUST run in its own migration: per Postgres semantics (and the runner's
-- per-file transaction wrapper), the new enum value cannot be referenced
-- in any same-transaction object. The companion migration 0047b widens the
-- CHECK constraints and adds the new partial unique index; 0047c creates the
-- `personal_research_evidence` projection table.
--
-- See docs/draft-personal-research-implementation.md §3.2, §5.

ALTER TYPE agent_task_operation ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH';

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_COMMAND_ACCEPTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_COMPLETED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PERSONAL_RESEARCH_CANCELLED';