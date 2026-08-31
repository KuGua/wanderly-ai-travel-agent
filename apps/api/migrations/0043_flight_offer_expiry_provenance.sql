-- Flight offer expiry provenance (spec §6.2 follow-up correctness fix).
--
-- The freshness guard previously inferred whether an offer's expires_at was
-- a real supplier commitment purely from provider_name === 'amadeus'. That
-- is unsafe: Amadeus itself falls back to a synthetic capturedAt+15min
-- heuristic whenever a specific offer lacks a real lastTicketingDate, and
-- the persisted row could not distinguish the two cases. Persist the
-- provenance explicitly instead of inferring it.
--
-- Nullable with no default and no backfill: every historical row predates
-- this column and its provenance is genuinely unknown. NULL is treated by
-- the application exactly like 'SYNTHETIC' (fail closed) — never upgraded
-- to 'PROVIDER_VERIFIED' retroactively.

ALTER TABLE provider_offers
  ADD COLUMN IF NOT EXISTS expiry_provenance varchar(32)
    CHECK (expiry_provenance IS NULL OR expiry_provenance IN ('PROVIDER_VERIFIED', 'SYNTHETIC'));
