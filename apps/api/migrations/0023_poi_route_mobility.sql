-- 0023_poi_route_mobility.sql
-- 全球 POI 与地面出行 (spec docs/ground-mobility-implementation.md) 阶段 1：契约与迁移。
--
-- 本迁移：
--   * 新增三个 pgEnum 与若干已有 enum 的值
--   * 新增 trip_places（POI 服务端权威）、navigation_route_evidence（路线证据）、
--     planning_research_results（任务终止时的安全 RESEARCH_SUMMARY）
--   * 不写任何 fixture 行；新增 category 仅在代码侧使用
--
-- IF NOT EXISTS / DO $$ 保证幂等；失败重跑不会脏化状态。

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_place_visibility') THEN
    DROP TYPE IF EXISTS trip_place_visibility CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_place_status') THEN
    DROP TYPE IF EXISTS trip_place_status CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_place_kind') THEN
    DROP TYPE IF EXISTS trip_place_kind CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'navigation_route_mode') THEN
    DROP TYPE IF EXISTS navigation_route_mode CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'research_result_status') THEN
    DROP TYPE IF EXISTS research_result_status CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mobility_service_type') THEN
    DROP TYPE IF EXISTS mobility_service_type CASCADE;
  END IF;
END $$;

CREATE TYPE trip_place_visibility AS ENUM (
  'OWNER_PRIVATE',
  'TEAM_VISIBLE',
  'ORCHESTRATOR_CONFIDENTIAL'
);

CREATE TYPE trip_place_status AS ENUM (
  'PROPOSED',
  'ACTIVE',
  'REVOKED'
);

CREATE TYPE trip_place_kind AS ENUM (
  'ATTRACTION',
  'HOTEL',
  'RESTAURANT',
  'TRANSPORT_HUB',
  'OTHER'
);

CREATE TYPE navigation_route_mode AS ENUM (
  'WALK',
  'DRIVE',
  'CYCLE'
);

CREATE TYPE research_result_status AS ENUM (
  'COMPLETE',
  'COMPLETED_WITH_GAPS'
);

CREATE TYPE mobility_service_type AS ENUM (
  'TAXI',
  'TRANSFER',
  'CHARTER',
  'RENTAL'
);

-- 扩展已有 enum（spec §4.3：task 可终止为 COMPLETED_WITH_GAPS；阶段 5 mobility 审计）
ALTER TYPE plan_status ADD VALUE IF NOT EXISTS 'PROPOSED';

ALTER TYPE agent_task_status ADD VALUE IF NOT EXISTS 'COMPLETED_WITH_GAPS';

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLACE_SEARCH_REQUESTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLACE_SEARCH_COMPLETED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'PLACE_SEARCH_UNAVAILABLE';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'NAVIGATION_ROUTE_REQUESTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'NAVIGATION_ROUTE_COMPLETED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'NAVIGATION_ROUTE_UNAVAILABLE';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'MOBILITY_OFFER_REQUESTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'MOBILITY_OFFER_COMPLETED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'MOBILITY_OFFER_UNAVAILABLE';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_PLACE_PROPOSED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_PLACE_ADOPTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'TRIP_PLACE_REVOKED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'RESEARCH_RESULT_RECORDED';

-- ─── trip_places ────────────────────────────────────────────────────────────
-- POI 服务端权威引用。坐标仅存 longitude/latitude，不进 telemetry/audit/log；
-- OWNER_PRIVATE place 永不进入 Shared snapshot（见 spec §4.1）。

DROP TABLE IF EXISTS trip_places CASCADE;

CREATE TABLE trip_places (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id              UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version              INTEGER NOT NULL DEFAULT 1,
  visibility           trip_place_visibility NOT NULL,
  status               trip_place_status NOT NULL DEFAULT 'PROPOSED',
  kind                 trip_place_kind NOT NULL,
  display_name         VARCHAR(256) NOT NULL,
  country_code         VARCHAR(2),
  city_name            VARCHAR(128),
  longitude            DOUBLE PRECISION,
  latitude             DOUBLE PRECISION,
  source               VARCHAR(256) NOT NULL,
  provider_place_id    VARCHAR(256),
  captured_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_from_run_id   UUID REFERENCES agent_task_runs(id) ON DELETE SET NULL,
  superseded_by_id     UUID REFERENCES trip_places(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trip_places_lon_lat_check
    CHECK ((longitude IS NULL AND latitude IS NULL)
       OR (longitude IS NOT NULL AND latitude IS NOT NULL
           AND longitude BETWEEN -180 AND 180
           AND latitude BETWEEN -90 AND 90))
);

-- 每条 trip 内每个 (display_name, kind, source) 同一时间最多一行 ACTIVE。
-- REVOKED 行保留审计但不阻塞同名复用。
CREATE UNIQUE INDEX trip_places_active_unique
  ON trip_places (trip_id, display_name, kind, source)
  WHERE status = 'ACTIVE';

CREATE INDEX trip_places_trip_status_idx
  ON trip_places (trip_id, status);

CREATE INDEX trip_places_trip_visibility_idx
  ON trip_places (trip_id, visibility);

CREATE INDEX trip_places_run_idx
  ON trip_places (created_from_run_id)
  WHERE created_from_run_id IS NOT NULL;

-- ─── navigation_route_evidence ──────────────────────────────────────────────
-- 服务端权威路线证据。geometry 是受保护的 Trip 数据，默认不进 LLM/日志/trace/audit。
-- 仅以 snapshotId + bound 进入授权 Trip UI 的 DTO。

DROP TABLE IF EXISTS navigation_route_evidence CASCADE;

CREATE TABLE navigation_route_evidence (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_run_id        UUID NOT NULL REFERENCES provider_search_runs(id) ON DELETE CASCADE,
  snapshot_id          UUID NOT NULL REFERENCES constraint_snapshots(id) ON DELETE CASCADE,
  trip_id              UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  origin_place_id      UUID NOT NULL REFERENCES trip_places(id) ON DELETE RESTRICT,
  destination_place_id UUID NOT NULL REFERENCES trip_places(id) ON DELETE RESTRICT,
  mode                 navigation_route_mode NOT NULL,
  distance_meters      DOUBLE PRECISION NOT NULL CHECK (distance_meters >= 0),
  duration_seconds     DOUBLE PRECISION NOT NULL CHECK (duration_seconds >= 0),
  steps                JSONB NOT NULL,
  encoded_geometry     TEXT NOT NULL,
  source               VARCHAR(256) NOT NULL,
  captured_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refresh_after        TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT navigation_route_evidence_origin_dest_check
    CHECK (origin_place_id <> destination_place_id)
);

CREATE INDEX navigation_route_evidence_snapshot_idx
  ON navigation_route_evidence (snapshot_id, trip_id);

CREATE INDEX navigation_route_evidence_pair_idx
  ON navigation_route_evidence (origin_place_id, destination_place_id, mode);

CREATE INDEX navigation_route_evidence_refresh_idx
  ON navigation_route_evidence (refresh_after);

-- ─── planning_research_results ──────────────────────────────────────────────
-- 任务终止时的安全 RESEARCH_SUMMARY（spec §4.2）。它不是 itinerary_plan，
-- 不携带 adoption/confirmation/booking authority。

DROP TABLE IF EXISTS planning_research_results CASCADE;

CREATE TABLE planning_research_results (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id              UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  snapshot_id          UUID NOT NULL REFERENCES constraint_snapshots(id) ON DELETE CASCADE,
  agent_task_run_id    UUID REFERENCES agent_task_runs(id) ON DELETE SET NULL,
  status               research_result_status NOT NULL,
  service_gaps         JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_plan_id       UUID REFERENCES itinerary_plans(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT planning_research_results_unique_per_task
    UNIQUE (agent_task_run_id)
);

CREATE INDEX planning_research_results_trip_snapshot_idx
  ON planning_research_results (trip_id, snapshot_id);

CREATE INDEX planning_research_results_status_idx
  ON planning_research_results (trip_id, status);