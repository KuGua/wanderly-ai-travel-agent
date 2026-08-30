-- 0021_team_orchestration_enums.sql
-- Phase 1 / Team Agent 协作编排 (spec §3.1). 全部在新事务中执行：
--   CREATE TYPE 与 ALTER TYPE ADD VALUE 在 PG 12+ 允许事务内执行；
--   新增值不能在同一事务内被 CREATE TABLE 等语句引用，故将表创建放到 0022。
--
-- Never repair a partial migration by dropping types: these enums can already
-- be referenced by durable trip facts and votes. The migration runner records
-- this file atomically, so a normal retry cannot observe a half-applied file.
DO $$ BEGIN
  CREATE TYPE constraint_visibility AS ENUM ('TEAM_VISIBLE', 'ORCHESTRATOR_CONFIDENTIAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE constraint_strength AS ENUM ('HARD', 'SOFT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE constraint_proposal_status AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE plan_adoption_decision AS ENUM ('ACCEPT', 'NEEDS_CHANGES');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE plan_status ADD VALUE IF NOT EXISTS 'PROPOSED';

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_CONSTRAINT_PROPOSED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_CONSTRAINT_CONFIRMED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_CONSTRAINT_REVOKED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLAN_REPLAN_ENQUEUED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLAN_ADOPTION_VOTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLAN_ADOPTED';
