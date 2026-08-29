-- 0022_team_orchestration_tables.sql
-- Phase 1 / Team Agent 协作编排 (spec §3.2, §3.3, §3.5)。
-- 三张新表，均带 partial unique index 守护活动状态唯一性。
--
-- This is a forward-only migration. Do not drop existing fact or vote tables
-- during an install/retry: they are authoritative state.

-- ─── trip_constraint_proposals ──────────────────────────────────────────────
-- Private, owner-reviewable candidate.

CREATE TABLE IF NOT EXISTS trip_constraint_proposals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id               UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_key             VARCHAR(64) NOT NULL,
  value_json            JSONB NOT NULL,
  value_hash            VARCHAR(64) NOT NULL,
  strength              constraint_strength NOT NULL,
  proposed_visibility  constraint_visibility NOT NULL,
  source_kind           VARCHAR(16) NOT NULL CHECK (source_kind IN ('PERSONAL_AGENT', 'OWNER_FORM')),
  status                constraint_proposal_status NOT NULL DEFAULT 'PENDING',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at           TIMESTAMPTZ,
  CONSTRAINT trip_constraint_proposals_status_check
    CHECK ((status = 'PENDING') = (resolved_at IS NULL))
);

-- 一位 owner 对同一字段同一 value 在 PENDING 状态下唯一（spec §3.2 唯一部分索引）
CREATE UNIQUE INDEX IF NOT EXISTS trip_constraint_proposals_pending_unique
  ON trip_constraint_proposals (trip_id, owner_user_id, field_key, value_hash)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS trip_constraint_proposals_trip_owner_idx
  ON trip_constraint_proposals (trip_id, owner_user_id, status);

-- ─── trip_constraint_facts ──────────────────────────────────────────────────
-- Per-trip, per-owner, per-field authoritative current fact.
-- monotonic revision；partial unique 守护仅一个 ACTIVE 行。

CREATE TABLE IF NOT EXISTS trip_constraint_facts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id             UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  owner_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_key           VARCHAR(64) NOT NULL,
  value_json          JSONB NOT NULL,
  value_hash          VARCHAR(64) NOT NULL,
  strength            constraint_strength NOT NULL,
  visibility          constraint_visibility NOT NULL,
  revision            INTEGER NOT NULL,
  source_proposal_id  UUID REFERENCES trip_constraint_proposals(id) ON DELETE SET NULL,
  status              VARCHAR(16) NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'REVOKED')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at       TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ
);

-- 每 (trip, owner, field) 最多一行 ACTIVE
CREATE UNIQUE INDEX IF NOT EXISTS trip_constraint_facts_active_unique
  ON trip_constraint_facts (trip_id, owner_user_id, field_key)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS trip_constraint_facts_trip_owner_field_idx
  ON trip_constraint_facts (trip_id, owner_user_id, field_key);

CREATE INDEX IF NOT EXISTS trip_constraint_facts_trip_visibility_idx
  ON trip_constraint_facts (trip_id, visibility);

-- ─── plan_adoption_votes ────────────────────────────────────────────────────
-- "全员 ACCEPT → ACTIVE" 采用投票。spec §3.5 强调与 member_confirmations 分离：
-- votes 决定 PROPOSED 是否转 ACTIVE；confirmations 仅在 ACTIVE 后授权 booking。

CREATE TABLE IF NOT EXISTS plan_adoption_votes (
  plan_id      UUID NOT NULL REFERENCES itinerary_plans(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision     plan_adoption_decision NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plan_id, user_id)
);

CREATE INDEX IF NOT EXISTS plan_adoption_votes_plan_idx ON plan_adoption_votes (plan_id);
