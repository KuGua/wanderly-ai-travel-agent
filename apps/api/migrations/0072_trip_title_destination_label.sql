-- 0072 — Trip title destination label (display-only).
-- shared_trips gains three columns that carry an optional destination label
-- (country/region only — never a city) used purely to give a country-only
-- DRAFT trip an informative title. The label is presentation-only and
-- never feeds destinationCandidates, constraint_snapshot, or any provider
-- query. See docs/trip-title-destination-label-implementation.md §D2/D3.
--
-- No backfill: existing rows leave all three columns NULL, so
-- buildTripTitle continues to emit the bare placeholder exactly as it did
-- today. The audit summary for any future write is restricted to a
-- `{source: "reference" | "llm"}` shape — the label text itself never
-- lands here (AGENTS.md privacy).
--
-- NOT VALID defers full-table validation; new writes are still constrained.
-- A follow-up migration will `VALIDATE CONSTRAINT` once the deployment is
-- stable (docs/trip-title-destination-label-implementation.md §14).
BEGIN;

ALTER TABLE shared_trips
  ADD COLUMN IF NOT EXISTS title_destination_label  varchar(64),
  ADD COLUMN IF NOT EXISTS title_label_source       varchar(16),
  ADD COLUMN IF NOT EXISTS title_label_updated_at   timestamptz;

ALTER TABLE shared_trips
  ADD CONSTRAINT shared_trips_title_label_source_check
  CHECK (
    (title_destination_label IS NULL AND title_label_source IS NULL)
    OR title_label_source IN ('REFERENCE', 'LLM')
  ) NOT VALID;

COMMIT;
