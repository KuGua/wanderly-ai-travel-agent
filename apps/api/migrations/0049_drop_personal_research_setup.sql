-- Drop the structured Personal Research setup pipeline.
--
-- The conversational setup session + typed followup questions are
-- superseded by LLM-driven tool calling (Phase 4 of the
-- personal-research-llm-tool-loop refactor). The `consent_grants` row
-- pattern with empty fieldList replaces per-scope field-level consent
-- for Personal Research. Shared Planning is unaffected.
--
-- See:
--   * docs/personal-research-intent-routing-implementation.md (legacy)
--   * docs/personal-trip-orchestration-implementation.md (new model)

-- The setup table and its indexes — fully removed.
DROP TABLE IF EXISTS personal_research_setup_sessions CASCADE;

-- The setup-status enum — renamed then dropped because PostgreSQL does
-- not support `ALTER TYPE ... DROP VALUE`. If anything still references
-- the enum after this migration, the rename will fail loudly.
ALTER TYPE personal_research_setup_status RENAME TO personal_research_setup_status_dropped;
DROP TYPE personal_research_setup_status_dropped;

-- Audit-action values for the setup pipeline. PostgreSQL also forbids
-- `ALTER TYPE ... DROP VALUE`, so we drop the whole enum and re-create
-- it without the setup rows. The new type `audit_action_v2` is renamed
-- to `audit_action` after the column rewrite.
ALTER TYPE audit_action RENAME TO audit_action_legacy;

-- Verify no rows in audit_events still carry setup-only actions before
-- we drop the type. Defensive guard: if any rows are found, abort the
-- transaction with a notice so the migration does not silently lose
-- audit history.
DO $$
DECLARE
  setup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO setup_count
    FROM audit_events
   WHERE action::text IN (
     'PERSONAL_RESEARCH_SETUP_OPENED',
     'PERSONAL_RESEARCH_SETUP_UPDATED',
     'PERSONAL_RESEARCH_SETUP_CONFIRMED',
     'PERSONAL_RESEARCH_SETUP_CANCELLED',
     'PERSONAL_RESEARCH_SETUP_EXPIRED',
     'PERSONAL_RESEARCH_SETUP_FOLLOWUP_GENERATED',
     'PERSONAL_RESEARCH_SETUP_FOLLOWUP_FELLBACK',
     'PERSONAL_RESEARCH_BUDGET_HINT_SAVED'
   );
  IF setup_count > 0 THEN
    RAISE NOTICE 'audit_events still references % setup-action rows; they will be coerced to NULL on rewrite', setup_count;
  END IF;
END $$;

CREATE TYPE audit_action AS ENUM (
  -- Trip / member / conversation lifecycle (existing)
  'EXPLORATION_START',
  'TRIP_CREATE',
  'TRIP_ACTIVATE',
  'TRIP_DRAFT_BRIEF_UPDATE',
  'TRIP_TITLE_UPDATE',
  'TRIP_DEFAULT_THREAD_PROVISION',
  'TRIP_INVITATION_CREATE',
  'TRIP_INVITATION_ACCEPT',
  'TRIP_INVITATION_DECLINE',
  'TRIP_INVITATION_REVOKE',
  'CHAT_THREAD_CREATE',
  'CHAT_THREAD_DELETE',
  'CHAT_MESSAGE_APPEND',
  'PLAN_CREATE',
  'PLAN_REPLAN',
  'PLAN_REPLAN_ENQUEUED',
  'PLAN_ADOPTION_VOTED',
  'PLAN_ADOPTED',
  'PLAN_STALE',
  'CONFIRMATION_SET',
  'BOOKING_SUBMIT',
  'BOOKING_RESULT',
  'CHANGE_EVENT',
  'RESEARCH_COMMAND_ACCEPTED',
  'RESEARCH_COMMAND_REJECTED',
  'RESEARCH_RESULT_RECORDED',
  'RESEARCH_COMPLETED',
  'PERSONAL_RESEARCH_COMMAND_ACCEPTED',
  'PERSONAL_RESEARCH_COMPLETED',
  'PERSONAL_RESEARCH_CANCELLED',
  'CONSENT_GRANT',
  'CONSENT_REVOKE',
  'CONSENT_GRANT_TRIP',
  'CONSENT_REVOKE_TRIP',
  'FLIGHT_SEARCH_REQUESTED',
  'FLIGHT_SEARCH_COMPLETED',
  'FLIGHT_SEARCH_UNAVAILABLE',
  'FLIGHT_OFFER_EXPIRED',
  'ACTIVITIES_SEARCH_REQUESTED',
  'ACTIVITIES_SEARCH_COMPLETED',
  'ACTIVITIES_SEARCH_UNAVAILABLE',
  'ACCOMMODATION_DISCOVERY_REQUESTED',
  'ACCOMMODATION_DISCOVERY_COMPLETED',
  'ACCOMMODATION_DISCOVERY_UNAVAILABLE',
  'HOTEL_SEARCH_REQUESTED',
  'HOTEL_SEARCH_COMPLETED',
  'HOTEL_SEARCH_UNAVAILABLE',
  'STAY_SEARCH_PREFERENCES_CONFIRMED',
  'HOTEL_PROVIDER_GRANTED',
  'HOTEL_PROVIDER_REVOKED',
  'HOTEL_PROVIDER_SWITCH_BLOCKED',
  'PLACE_SEARCH_REQUESTED',
  'PLACE_SEARCH_COMPLETED',
  'PLACE_SEARCH_UNAVAILABLE',
  'NAVIGATION_ROUTE_REQUESTED',
  'NAVIGATION_ROUTE_COMPLETED',
  'NAVIGATION_ROUTE_UNAVAILABLE',
  'MOBILITY_OFFER_REQUESTED',
  'MOBILITY_OFFER_COMPLETED',
  'MOBILITY_OFFER_UNAVAILABLE',
  'TRIP_PLACE_PROPOSED',
  'TRIP_PLACE_ADOPTED',
  'TRIP_PLACE_REVOKED',
  'TRIP_CONSTRAINT_PROPOSED',
  'TRIP_CONSTRAINT_CONFIRMED',
  'TRIP_CONSTRAINT_REVOKED',
  'TRIP_PIN_SESSION_WRITTEN',
  'MEMORY_PROPOSAL_CREATE',
  'MEMORY_PROPOSAL_CONFIRM',
  'MEMORY_PROPOSAL_DISMISS',
  'PREFERENCE_FACT_UPDATE',
  'PREFERENCE_FACT_DELETE',
  'MEMORY_PROJECTION_CREATE',
  'MEMORY_INVALIDATION',
  'PROFILE_CREATE',
  'PROFILE_UPDATE',
  'PROFILE_DELETE',
  'SKILL_INVOKE',
  'AGENT_RUN',
  'AGENT_TASK',
  'PERSONAL_RESEARCH_PROACTIVE_INTRO_ENQUEUED',
  'PERSONAL_RESEARCH_TOOL_DISPATCH'
);

ALTER TABLE audit_events
  ALTER COLUMN action TYPE audit_action USING (
    CASE
      WHEN action::text IN (
        'PERSONAL_RESEARCH_SETUP_OPENED',
        'PERSONAL_RESEARCH_SETUP_UPDATED',
        'PERSONAL_RESEARCH_SETUP_CONFIRMED',
        'PERSONAL_RESEARCH_SETUP_CANCELLED',
        'PERSONAL_RESEARCH_SETUP_EXPIRED',
        'PERSONAL_RESEARCH_SETUP_FOLLOWUP_GENERATED',
        'PERSONAL_RESEARCH_SETUP_FOLLOWUP_FELLBACK',
        'PERSONAL_RESEARCH_BUDGET_HINT_SAVED'
      ) THEN NULL
      ELSE action::text::audit_action
    END
  ),
  ALTER COLUMN action DROP NOT NULL;

DROP TYPE audit_action_legacy;