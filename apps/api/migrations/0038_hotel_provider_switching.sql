-- 0038 — Hotel provider switching (Nuitee Connect / LiteAPI Rates as the
-- default; SerpApi Google Hotels as an explicitly switchable alternate).
--
-- Spec: docs/nuitee-serpapi-hotel-provider-switching-implementation.md §5
-- and §7 step 1. Captures:
--   * the server-controlled provider name bound to each accepted task
--     (per-run provider persistence, no auto-fallback, no mixed sources);
--   * a provider-only field-level authorization table for values that
--     must NOT enter Profile / LLM prompt / shared DTO / telemetry
--     (e.g. Nuitee `guestNationality`);
--   * a tightened unique index that prevents a task from racing two
--     different providers against the same destination in the same
--     snapshot.
--
-- Reversible. The down migration drops the new table, the new column,
-- and restores the original hotel-task-destination unique index. It
-- does NOT rewrite existing `provider_search_runs` rows.

-- ─── 1. New audit actions ──────────────────────────────────────────────────
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'HOTEL_PROVIDER_GRANTED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'HOTEL_PROVIDER_REVOKED';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'HOTEL_PROVIDER_SWITCH_BLOCKED';

-- ─── 2. New hotel_provider enum ────────────────────────────────────────────
-- Mirrors the union in apps/api/src/providers/types.ts. Adding a third
-- provider later requires a new enum value AND a new audit action AND a
-- metrics allow-list update.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'hotel_provider') THEN
    CREATE TYPE hotel_provider AS ENUM ('nuitee_connect', 'serpapi_google_hotels');
  END IF;
END
$$;

-- ─── 3. agent_task_runs.hotel_provider ─────────────────────────────────────
-- Nullable: only set for tasks whose operation accepts a hotel capability.
-- Persisted at task acceptance time from the resolved `HOTEL_PROVIDER`
-- env value; never re-read mid-run and never mutated by config reloads.
ALTER TABLE agent_task_runs
  ADD COLUMN IF NOT EXISTS hotel_provider hotel_provider;

-- ─── 4. Provider-only stay-search authorizations ───────────────────────────
-- Holds values that adapters require (e.g. Nuitee `guestNationality`)
-- but must never appear in Profile / shared DTO / LLM prompt / log /
-- trace / metric / audit. First field is `guest_nationality`; the
-- schema is generic so subsequent provider-only fields reuse it.
--
--   * `value_encrypted` is opaque ciphertext; only server-side KMS
--     code can decrypt it, and that code runs only inside the adapter
--     call path. The plaintext NEVER leaves that path.
--   * `status` mirrors the consent lifecycle: ACTIVE means usable for
--     new quotes, REVOKED means disabled but historically present,
--     EXPIRED means naturally past `expires_at`.
--   * `version` increases on every grant for the same
--     (trip, member, provider, field); changes invalidate dependent
--     plans via stalePlansAndConfirmationsForTrip().
--   * Confidentiality: the table deliberately does NOT log its rows
--     in any default SELECT list. Adapters fetch only the row they
--     own, by id.
CREATE TABLE IF NOT EXISTS stay_search_provider_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES shared_trips(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES users(id),
  provider_name hotel_provider NOT NULL,
  field VARCHAR(64) NOT NULL
    CHECK (field IN ('guest_nationality')),
  -- Server-only ciphertext; KMS key id and decryption live outside this
  -- schema. Length cap protects against accidental plaintext dumps.
  value_encrypted TEXT NOT NULL CHECK (length(value_encrypted) BETWEEN 16 AND 4096),
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One ACTIVE row per (trip, member, provider, field).
CREATE UNIQUE INDEX IF NOT EXISTS stay_search_provider_authorizations_active_unique
  ON stay_search_provider_authorizations(trip_id, member_id, provider_name, field)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS stay_search_provider_authorizations_trip_idx
  ON stay_search_provider_authorizations(trip_id);

CREATE INDEX IF NOT EXISTS stay_search_provider_authorizations_member_idx
  ON stay_search_provider_authorizations(member_id);

-- ─── 5. Tighten hotel-task-destination dedupe to include provider ──────────
-- Spec §3.1 + §7 step 1: a single task bound to one provider. The
-- original index did not include `provider_name` so two providers could
-- each insert a PENDING row for the same (task, snapshot, destination).
-- We drop and recreate; existing rows survive because the partial WHERE
-- clause still matches.
DROP INDEX IF EXISTS provider_search_runs_hotel_task_destination_unique;

CREATE UNIQUE INDEX IF NOT EXISTS provider_search_runs_hotel_task_provider_unique
  ON provider_search_runs(agent_task_run_id, snapshot_id, destination_id, provider_name)
  WHERE agent_task_run_id IS NOT NULL
    AND destination_id IS NOT NULL
    AND category = 'hotel';
