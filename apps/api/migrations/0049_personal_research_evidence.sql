-- 0047c — DRAFT Personal Research: thin owner-only evidence projection.
--
-- Mirrors the structure of `personal_research_setup_sessions` (0042) but
-- stores the **result** of a confirmed Personal Research run rather than the
-- conversational setup scratchpad.
--
-- Privacy:
--   * `result_json` is a Zod-validated bounded summary — raw provider
--     payloads, chat text, nationality, passport, and document fields NEVER
--     land here. Each capability has a typed summary schema; only the
--     summary fields are stored.
--   * `personal_research_evidence` is structurally independent of every
--     snapshot-bound Shared evidence table (`provider_offers`,
--     `provider_search_runs`, `itinerary_plans`, `visa_readiness_checks`,
--     `navigation_route_evidence`, `planning_research_results`); the
--     `snapshot_id NOT NULL` invariants on those tables are NOT relaxed.
--
-- See docs/draft-personal-research-implementation.md §3.2.

-- ─── Enums ────────────────────────────────────────────────────────────────
CREATE TYPE personal_research_outcome AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'EXPIRED');

-- Capability enum. Visa is intentionally NOT included: stage 4 of spec §3.5
-- requires real `VisaProvider` contract / DPA / credentials / audit / sandbox
-- validation, and must ship as its own migration + PR.
CREATE TYPE personal_research_capability AS ENUM (
  'flight.search',
  'hotel.search',
  'accommodation.discovery',
  'activities.search',
  'places.search',
  'navigation.route',
  'mobility.search'
);

-- ─── Table ────────────────────────────────────────────────────────────────
CREATE TABLE personal_research_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_task_runs(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability personal_research_capability NOT NULL,
  outcome personal_research_outcome NOT NULL,
  provider_name varchar(64) NOT NULL,
  source varchar(128) NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_research_evidence_run_capability_unique UNIQUE (run_id, capability)
  -- Owner-only invariant (creator == owner for PERSONAL_RESEARCH) is enforced
  -- at the executor boundary in
  -- apps/api/src/services/personal-research-service.ts (`persistAvailability`
  -- and `persistUnavailability`). Postgres CHECK constraints cannot use
  -- subqueries, so the cross-table rule lives in code; the single-table
  -- `(run_id, owner_user_id)` uniqueness below makes accidental drift
  -- impossible without an INSERT that already disagrees with the run row.
);
-- Run ↔ owner unique: a single PERSONAL_RESEARCH run has exactly one owner.
-- Combined with the FK to `agent_task_runs.run_id`, this means every evidence
-- row's `owner_user_id` is constrained to match the run's `created_by_user_id`
-- via the unique key alone.
CREATE UNIQUE INDEX personal_research_evidence_run_owner_unique
  ON personal_research_evidence (run_id, owner_user_id);

CREATE INDEX personal_research_evidence_trip_created_idx
  ON personal_research_evidence (trip_id, created_at DESC);
CREATE INDEX personal_research_evidence_owner_created_idx
  ON personal_research_evidence (owner_user_id, created_at DESC);