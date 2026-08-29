-- 0021_team_orchestration_enums.sql
-- Phase 1 / Team Agent 协作编排 (spec §3.1). 全部在新事务中执行：
--   CREATE TYPE 与 ALTER TYPE ADD VALUE 在 PG 12+ 允许事务内执行；
--   新增值不能在同一事务内被 CREATE TABLE 等语句引用，故将表创建放到 0022。
--
-- IF NOT EXISTS 保证幂等；同一文件可被多次 apply 不会出错。
-- `DO $$ … $$` 块用于在 CREATE TYPE 之前把不可见的脏数据清掉：
--   先前一次部分失败的 install 可能产生过同名 enum 但未提交 schema_migrations 行。

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'constraint_visibility') THEN
    DROP TYPE IF EXISTS constraint_visibility CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'constraint_strength') THEN
    DROP TYPE IF EXISTS constraint_strength CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'constraint_proposal_status') THEN
    DROP TYPE IF EXISTS constraint_proposal_status CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_adoption_decision') THEN
    DROP TYPE IF EXISTS plan_adoption_decision CASCADE;
  END IF;
END $$;

CREATE TYPE constraint_visibility AS ENUM (
  'TEAM_VISIBLE',
  'ORCHESTRATOR_CONFIDENTIAL'
);

CREATE TYPE constraint_strength AS ENUM (
  'HARD',
  'SOFT'
);

CREATE TYPE constraint_proposal_status AS ENUM (
  'PENDING',
  'CONFIRMED',
  'DISMISSED',
  'REVOKED'
);

CREATE TYPE plan_adoption_decision AS ENUM (
  'ACCEPT',
  'NEEDS_CHANGES'
);

ALTER TYPE plan_status ADD VALUE IF NOT EXISTS 'PROPOSED';

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_CONSTRAINT_PROPOSED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_CONSTRAINT_CONFIRMED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_CONSTRAINT_REVOKED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLAN_REPLAN_ENQUEUED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLAN_ADOPTION_VOTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLAN_ADOPTED';
