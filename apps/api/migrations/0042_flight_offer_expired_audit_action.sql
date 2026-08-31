-- Flight offer staleness guard (spec §6.2) — confirmation and booking must
-- revalidate every selected flight offer's freshness (adoption does not).
-- Adds the audit action recorded when that revalidation rejects an offer as
-- expired, missing an expiry, or sourced from a provider that cannot supply
-- a verifiable one.

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'FLIGHT_OFFER_EXPIRED';
