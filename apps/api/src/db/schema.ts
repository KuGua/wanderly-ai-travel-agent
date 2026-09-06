import { sql } from "drizzle-orm";
import { pgTable, uuid, varchar, text, timestamp, date, jsonb, boolean, integer, bigint, doublePrecision, pgEnum, uniqueIndex, index, primaryKey } from "drizzle-orm/pg-core";

// ─── Inline structural types ─────────────────────────────────────────────────
// These mirror the Zod schemas in src/types/schemas.ts so the Drizzle column
// typing stays self-contained (no upstream cycle). Parity is locked by
// schema tests under tests/contracts/.

export type ResearchIntentCapability =
  | "flight"
  | "accommodation"
  | "hotel"
  | "activities"
  | "places"
  | "navigation"
  | "mobility"
  | "readiness";

export type ResearchIntentMissingCode =
  | "TRIP_NOT_ACTIVE"
  | "DESTINATION_NOT_CONFIGURED"
  | "DATES_MISSING"
  | "FLIGHT_PREFERENCES_MISSING"
  | "STAY_PREFERENCES_MISSING"
  | "HOTEL_PROVIDER_NOT_APPROVED"
  | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING"
  | "ROUTE_ENDPOINTS_UNCONFIRMED"
  | "MODE_NOT_CHOSEN"
  | "BUDGET_HINT_MISSING";

export type ResearchIntentReadiness =
  | "READY"
  | "READY_WITH_WARNINGS"
  | "NEEDS_SETUP"
  | "NEEDS_PLACE_SELECTION";

export interface ResearchIntentDraftShape {
  schemaVersion: 1;
  kind: "RESEARCH_ONLY" | "PROPOSE_PLAN";
  requestedCapabilities: ResearchIntentCapability[];
  classifierVersion: string;
  readiness: ResearchIntentReadiness;
  /** Hard blockers — optional for backward compatibility with drafts
   *  persisted before the Phase 2 two-tier split. Old rows are `null`. */
  blockers: ResearchIntentMissingCode[] | null;
  /** Soft warnings — optional for backward compatibility. Old rows are
   *  `null`. */
  warnings: ResearchIntentMissingCode[] | null;
  /** Union of `blockers ∪ warnings`. Retained for backward compatibility
   *  with older clients that still read `missing[]` directly. */
  missing: ResearchIntentMissingCode[];
  /** Quick orchestration — proactive intro marker. Optional so legacy
   *  drafts parse cleanly. When `true`, the conversation worker renders
   *  the locale-aware greeting template without an LLM call. */
  proactiveIntro?: true;
}

// ─── Enums ───────────────────────────────────────────────────────────────────

export const tripStatusEnum = pgEnum("trip_status", ["DRAFT", "PLANNING", "CONFIRMED", "BOOKED", "CANCELLED", "STALE"]);
export const planStatusEnum = pgEnum("plan_status", ["DRAFT", "ACTIVE", "PROPOSED", "STALE", "SUPERSEDED"]);
export const confirmationStatusEnum = pgEnum("confirmation_status", ["PENDING", "CONFIRMED", "NEEDS_CHANGES", "STALE"]);
export const consentScopeEnum = pgEnum("consent_scope", [
  "PROFILE_BASIC",        // name, avatar
  "PROFILE_PREFERENCES",  // travel preferences, interests
  "PROFILE_NATIONALITY",  // nationality / citizenship
  "PROFILE_DOCUMENTS",    // passport info (redacted display)
  "PROFILE_BUDGET",       // budget constraints
  "PROFILE_RESTRICTIONS", // red-eye refusal, mobility, etc.
]);
export const bookingStatusEnum = pgEnum("booking_status", ["PENDING", "SUBMITTED", "SUCCESS", "FAILED", "DUPLICATE"]);
export const outboxStatusEnum = pgEnum("outbox_status", [
  "PENDING",
  // Claimed by a worker. Recoverable: a claim older than the lease is retried,
  // so a crash mid-handler does not lose the event (migration 0029).
  "PROCESSING",
  "PROCESSED",
  "FAILED",
]);
export const agentTaskOperationEnum = pgEnum("agent_task_operation", ["CONVERSATION", "PLAN", "REPLAN", "RESEARCH", "PERSONAL_RESEARCH"]);
export const agentTaskStatusEnum = pgEnum("agent_task_status", [
  "QUEUED", "RUNNING", "CANCEL_REQUESTED", "COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED", "STALE",
]);
// Lifecycle of the persisted research-intent draft on a CONVERSATION run.
// The draft is never authoritative — see docs/personal-research-intent-routing-implementation.md §4.1, §7 Phase 0.
export const researchIntentStateEnum = pgEnum("research_intent_state", [
  "PROPOSED", "DISMISSED", "CONFIRMED", "SUPERSEDED",
]);
export const destinationCueBatchStatusEnum = pgEnum("destination_cue_batch_status", [
  "OPEN", "RESOLVED", "SUPERSEDED", "EXPIRED",
]);
export const destinationCueCandidateStatusEnum = pgEnum("destination_cue_candidate_status", [
  "PENDING", "ACCEPTED", "DISMISSED", "SUPERSEDED",
]);
// Flight / Hotel Offer Cue lifecycle states. Personal-only; never used by
// Shared Plan / booking authority.
export const offerCueCapabilityEnum = pgEnum("offer_cue_capability", [
  "flight", "hotel",
]);
export const offerCueBatchStatusEnum = pgEnum("offer_cue_batch_status", [
  "OPEN", "RESOLVED", "SUPERSEDED", "EXPIRED",
]);
export const offerCueCandidateStatusEnum = pgEnum("offer_cue_candidate_status", [
  "PENDING", "ACCEPTED", "DISMISSED", "EXPIRED",
]);
export const offerCueCandidateIntentEnum = pgEnum("offer_cue_candidate_intent", [
  "EXPLICIT_SELECT", "STRONG_PREFERENCE",
]);
export const personalOfferSelectionStatusEnum = pgEnum("personal_offer_selection_status", [
  "ACTIVE", "SUPERSEDED", "EXPIRED", "REMOVED",
]);

/**
 * Setup-scratchpad lifecycle (OPEN/CONFIRMED/CANCELLED/EXPIRED/SUPERSEDED)
 * was dropped with the conversational setup pipeline
 * (migrations/0049_drop_personal_research_setup.sql). Enum is removed.
 */
// personalResearchSetupStatusEnum intentionally deleted in 0049.

export const auditActionEnum = pgEnum("audit_action", [
  "PROFILE_CREATE", "PROFILE_UPDATE", "PROFILE_DELETE",
  "TRIP_CREATE", "TRIP_JOIN",
  "CONSENT_GRANT", "CONSENT_REVOKE",
  // Trip-level consent for Personal Research (Phase 3):
  "CONSENT_GRANT_TRIP", "CONSENT_REVOKE_TRIP",
  "PLAN_CREATE", "PLAN_STALE", "PLAN_REPLAN", "PLAN_RESTART",
  "CONFIRMATION_SET",
  "BOOKING_SUBMIT", "BOOKING_RESULT",
  "CHANGE_EVENT",
  "VISA_CHECK",
  "CHAT_THREAD_CREATE", "CHAT_THREAD_DELETE", "CHAT_MESSAGE_APPEND",
  "TRIP_INVITATION_CREATE", "TRIP_INVITATION_ACCEPT",
  "TRIP_INVITATION_REVOKE", "TRIP_INVITATION_DECLINE", "TRIP_DEFAULT_THREAD_PROVISION",
  "EXPLORATION_START", "TRIP_ACTIVATE", "TRIP_TITLE_UPDATE", "TRIP_DRAFT_BRIEF_UPDATE",
  // Trip title destination-label lifecycle (docs/trip-title-destination-label-implementation.md §10.3).
  // The summary's `source` field is "reference" | "llm" — the label text
  // itself never appears here.
  "TRIP_TITLE_LABEL_UPDATE",
  "DESTINATION_CUE_ACCEPT", "DESTINATION_CUE_DISMISS",
  // Flight / Hotel Offer Cue (docs/flight-offer-cue-model-draft.md §10,
  // docs/hotel-offer-cue-model-draft.md §9; added via 0077_offer_cue_audit_enums.sql).
  // Acceptance writes only to personal_offer_selections; no booking, no plan,
  // no Shared agent re-trigger. The audit summary carries capability + cueId
  // + candidateId — never carrier, property name, price, provider ID or route.
  "FLIGHT_OFFER_CUE_ACCEPT", "FLIGHT_OFFER_CUE_DISMISS",
  "HOTEL_OFFER_CUE_ACCEPT", "HOTEL_OFFER_CUE_DISMISS",
  // Archive is a reversible hide, not a delete (0061_trip_archive_audit_actions.sql).
  "TRIP_ARCHIVE", "TRIP_UNARCHIVE", "TRIP_DELETE",
  // Private thread title lifecycle (docs/thread-title-lifecycle-implementation.md §11.2,
  // added via 0070_thread_title_audit_action.sql). The summary's `source`
  // field distinguishes deterministic / llm / manual — the title text itself
  // never lands in the audit log.
  "CHAT_THREAD_TITLE_UPDATE",
  "SKILL_INVOKE", "AGENT_RUN", "AGENT_TASK",
  "FLIGHT_SEARCH_REQUESTED", "FLIGHT_SEARCH_COMPLETED", "FLIGHT_SEARCH_UNAVAILABLE",
  "FLIGHT_OFFER_EXPIRED",
  "ACTIVITIES_SEARCH_REQUESTED", "ACTIVITIES_SEARCH_COMPLETED", "ACTIVITIES_SEARCH_UNAVAILABLE",
  "ACCOMMODATION_DISCOVERY_REQUESTED", "ACCOMMODATION_DISCOVERY_COMPLETED", "ACCOMMODATION_DISCOVERY_UNAVAILABLE",
  "HOTEL_SEARCH_REQUESTED", "HOTEL_SEARCH_COMPLETED", "HOTEL_SEARCH_UNAVAILABLE",
  "STAY_SEARCH_PREFERENCES_CONFIRMED",
  // Phase 2 / spec §8 audit surface (added via 0021_team_orchestration_enums.sql):
  "TRIP_CONSTRAINT_PROPOSED",
  "TRIP_CONSTRAINT_CONFIRMED",
  "TRIP_CONSTRAINT_REVOKED",
  "PLAN_REPLAN_ENQUEUED",
  "PLAN_ADOPTION_VOTED",
  "PLAN_ADOPTED",
  // Global POI & ground mobility (added via 0023_poi_route_mobility.sql):
  "PLACE_SEARCH_REQUESTED",
  "PLACE_SEARCH_COMPLETED",
  "PLACE_SEARCH_UNAVAILABLE",
  "NAVIGATION_ROUTE_REQUESTED",
  "NAVIGATION_ROUTE_COMPLETED",
  "NAVIGATION_ROUTE_UNAVAILABLE",
  "MOBILITY_OFFER_REQUESTED",
  "MOBILITY_OFFER_COMPLETED",
  "MOBILITY_OFFER_UNAVAILABLE",
  "TRIP_PLACE_PROPOSED",
  "TRIP_PLACE_ADOPTED",
  "TRIP_PLACE_REVOKED",
  "RESEARCH_RESULT_RECORDED",
  // Phase 2 / Personal Trip Orchestrator (added via 0035_personal_research_audit_actions.sql):
  "RESEARCH_COMMAND_ACCEPTED",
  "RESEARCH_COMMAND_REJECTED",
  "RESEARCH_COMPLETED",
  // Long-term memory (docs/long-term-memory-implementation.md section 7):
  "MEMORY_PROPOSAL_CREATE", "MEMORY_PROPOSAL_CONFIRM", "MEMORY_PROPOSAL_DISMISS",
  // Free-text memories (migration 0059).
  "FREE_TEXT_MEMORY_CREATE", "FREE_TEXT_MEMORY_DELETE",
  "PREFERENCE_FACT_UPDATE", "PREFERENCE_FACT_DELETE",
  "TRIP_MEMORY_UPDATE", "TRIP_MEMORY_DELETE",
  "MEMORY_PROJECTION_CREATE", "MEMORY_INVALIDATION",
  // Hotel provider switching (docs/nuitee-serpapi-hotel-provider-switching-implementation.md §5):
  "HOTEL_PROVIDER_GRANTED", "HOTEL_PROVIDER_REVOKED", "HOTEL_PROVIDER_SWITCH_BLOCKED",
  // Personal Research setup pipeline values removed in 0049.
  // Member conversation handoff (docs/member-conversation-handoff-implementation.md §10,
  // added via 0056_conversation_constraint_handoff.sql):
  "MEMBER_CONVERSATION_CANDIDATES_CREATED",
  "MEMBER_CONVERSATION_HANDOFF_CONFIRMED",
  "MEMBER_CONVERSATION_HANDOFF_REJECTED",
  // Quick orchestration (proactive-intro enqueue kept):
  "PERSONAL_RESEARCH_PROACTIVE_INTRO_ENQUEUED",
  // LLM-driven Personal Research tool dispatch (added via 0049):
  "PERSONAL_RESEARCH_TOOL_DISPATCH",
  "TRIP_PIN_SESSION_WRITTEN",
  // DRAFT Personal Research (added via 0047a, docs/draft-personal-research-implementation.md §3.2):
  "PERSONAL_RESEARCH_COMMAND_ACCEPTED",
  "PERSONAL_RESEARCH_COMPLETED",
  "PERSONAL_RESEARCH_CANCELLED",
]);

// ─── Long-term memory (docs/long-term-memory-implementation.md) ─────────────
export const memoryFieldCategoryEnum = pgEnum("memory_field_category", ["PREFERENCE", "CONSTRAINT"]);
export const preferenceFactSourceEnum = pgEnum("preference_fact_source", ["PROFILE_FORM", "PROPOSAL_CONFIRMATION"]);
export const preferenceFactStatusEnum = pgEnum("preference_fact_status", ["ACTIVE", "SUPERSEDED"]);
export const memoryProposalSourceEnum = pgEnum("memory_proposal_source", ["BEHAVIOR_AGGREGATION"]);
export const memoryProposalStatusEnum = pgEnum("memory_proposal_status", ["PENDING", "CONFIRMED", "DISMISSED", "EXPIRED"]);

// Chat thread scope — MVP allows only TRIP-scoped threads; adding new
// scopes later requires explicit schema + migration work.
export const chatThreadScopeEnum = pgEnum("chat_thread_scope", ["TRIP"]);

export const tripInvitationStatusEnum = pgEnum("trip_invitation_status", [
  "PENDING", "ACCEPTED", "DECLINED", "REVOKED", "EXPIRED",
]);

/**
 * Hotel provider identity. Mirrors `apps/api/src/providers/types.ts`
 * `HotelProviderName` (and the narrower `HotelOfferProviderName`); the
 * DB enum excludes `"unconfigured"` because an offer only exists when
 * a real adapter produced it. Adding a new provider requires both an
 * enum value here AND a metrics allow-list update in
 * `apps/api/src/observability/metrics.ts`.
 */
export const hotelProviderEnum = pgEnum("hotel_provider", [
  "nuitee_connect",
  "serpapi_google_hotels",
]);

export const staySearchProviderAuthorizationStatusEnum = pgEnum("stay_search_provider_authorization_status", [
  "ACTIVE",
  "REVOKED",
  "EXPIRED",
]);

export const staySearchProviderAuthorizationFieldEnum = pgEnum("stay_search_provider_authorization_field", [
  "guest_nationality",
]);

// S4 / docs/location-introduction-cache-implementation.md §4.  Shared,
// non-personalized destination-introduction cache.  No user/Trip/thread
// identifiers are stored here.
export const locationIntroductionStatusEnum = pgEnum("location_introduction_status", [
  "GENERATING",
  "READY",
]);

// ─── Team Agent 协作编排 (Phase 1+2, doc: docs/team-agent-orchestration-implementation.md) ──
// Value list mirrored to `apps/api/src/types/domain.ts` and `types/schemas.ts`.
export const constraintVisibilityEnum = pgEnum("constraint_visibility", [
  "TEAM_VISIBLE",
  "ORCHESTRATOR_CONFIDENTIAL",
]);
/**
 * Distinguishes team-orchestration constraints from long-term-memory overrides
 * and group decisions, so each keeps its own active-uniqueness rule in one
 * table. See migration 0028.
 */
export const tripConstraintKindEnum = pgEnum("trip_constraint_kind", [
  "MEMBER_CONSTRAINT",
  "PERSONAL_OVERRIDE",
  "GROUP_DECISION",
]);
export const constraintStrengthEnum = pgEnum("constraint_strength", [
  "HARD",
  "SOFT",
]);
export const constraintProposalStatusEnum = pgEnum("constraint_proposal_status", [
  "PENDING",
  "CONFIRMED",
  "DISMISSED",
  "REVOKED",
]);
export const planAdoptionDecisionEnum = pgEnum("plan_adoption_decision", [
  "ACCEPT",
  "NEEDS_CHANGES",
]);

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: varchar("external_id", { length: 128 }).unique().notNull(), // Verified Cognito subject or "custom:<username>"
  displayName: varchar("display_name", { length: 128 }).notNull(),
  username: varchar("username", { length: 32 }).unique(),
  email: varchar("email", { length: 256 }).unique(),
  passwordHash: varchar("password_hash", { length: 256 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
// ─── User Profiles (private by default) ─────────────────────────────────────

export const userProfiles = pgTable("user_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull().unique(),
  // Private fields — never shared without explicit consent
  nationality: varchar("nationality", { length: 64 }),          // e.g. "CN", "US"
  passportNumber: varchar("passport_number", { length: 64 }),   // sensitive — never logged
  dateOfBirth: varchar("date_of_birth", { length: 10 }),        // YYYY-MM-DD
  // Preferences
  interests: jsonb("interests").$type<string[]>(),               // ["art","food","history"]
  accommodationStyle: varchar("accommodation_style", { length: 32 }), // "city_center","budget","luxury"
  budgetMaxUsd: integer("budget_max_usd"),
  noRedEye: boolean("no_red_eye").default(false),
  mobilityNotes: text("mobility_notes"),
  availableDepartureDates: jsonb("available_departure_dates").$type<string[]>(), // ["2025-07-01","2025-07-15"]
  departureCity: varchar("departure_city", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Preference Facts (granular, editable) ──────────────────────────────────

export const preferenceFacts = pgTable("preference_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  profileId: uuid("profile_id").references(() => userProfiles.id, { onDelete: "cascade" }).notNull(),
  fieldKey: varchar("field_key", { length: 64 }).notNull(),     // "interests", "budget_max_usd", etc.
  fieldValue: jsonb("field_value"),
  category: memoryFieldCategoryEnum("category").default("PREFERENCE").notNull(),
  source: preferenceFactSourceEnum("source").default("PROFILE_FORM").notNull(),
  status: preferenceFactStatusEnum("status").default("ACTIVE").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  supersedesFactId: uuid("supersedes_fact_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Behaviour-derived candidates awaiting the owner's decision. A proposal is
 * never an authoritative fact: confirming one is what creates the fact.
 *
 * `observationCount` / `lastObservedAt` are aggregate counters only. No
 * behavioural timeline is stored (§3.2).
 */
export const memoryProposals = pgTable("memory_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  profileId: uuid("profile_id").references(() => userProfiles.id, { onDelete: "cascade" }).notNull(),
  fieldKey: varchar("field_key", { length: 64 }).notNull(),
  proposedValue: jsonb("proposed_value").notNull(),
  proposedValueHash: text("proposed_value_hash").notNull(),
  source: memoryProposalSourceEnum("source").default("BEHAVIOR_AGGREGATION").notNull(),
  observationCount: integer("observation_count").default(1).notNull(),
  firstObservedOn: date("first_observed_on").notNull(),
  lastObservedOn: date("last_observed_on").notNull(),
  /** Bounded UTC-day window; DB CHECK caps it at 10. Duplicates allowed. */
  recentObservedOn: date("recent_observed_on").array().default([]).notNull(),
  distinctEpisodeCount: integer("distinct_episode_count").default(0).notNull(),
  distinctTripCount: integer("distinct_trip_count").default(0).notNull(),
  /** Internal only — never returned, logged, traced or audited. */
  contributingTripIds: uuid("contributing_trip_ids").array().default([]).notNull(),
  scoringVersion: varchar("scoring_version", { length: 32 }).default("petrov-hybrid-v1").notNull(),
  status: memoryProposalStatusEnum("status").default("PENDING").notNull(),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedFactId: uuid("resolved_fact_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("memory_proposals_user_status_idx").on(table.userId, table.status),
]);

// ─── Shared Trips ───────────────────────────────────────────────────────────

export const sharedTrips = pgTable("shared_trips", {
  /**
   * The brief extracted from conversation but not yet confirmed. A candidate,
   * never a fact: it is cleared the moment the traveller confirms or ignores,
   * and the confirmed values live in the columns below. Kept on the trip
   * because that is what it describes — on a run it disappeared the moment the
   * run stopped being polled, which is any reload.
   */
  pendingBriefProposal: jsonb("pending_brief_proposal"),
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 256 }).notNull(),
  nameSource: varchar("name_source", { length: 16 }).$type<"AUTO" | "MANUAL">().default("MANUAL").notNull(),
  titleLocale: varchar("title_locale", { length: 8 }).$type<"en" | "zh" | null>(),
  // Display-only destination label (docs/trip-title-destination-label-implementation.md §D2/D3).
  // Country/region only, never a city. Never feeds destinationCandidates,
  // constraint_snapshot, or any provider query. NULL on all existing rows.
  titleDestinationLabel: varchar("title_destination_label", { length: 64 }),
  titleLabelSource: varchar("title_label_source", { length: 16 }).$type<"REFERENCE" | "LLM" | null>(),
  titleLabelUpdatedAt: timestamp("title_label_updated_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  status: tripStatusEnum("status").default("PLANNING").notNull(),
  departureCities: jsonb("departure_cities").$type<string[]>().notNull(),   // ["Shanghai","San Francisco"]
  destinationCandidates: jsonb("destination_candidates").$type<string[]>().notNull(), // ["Tokyo","Bangkok","Seoul"]
  travelDateStart: varchar("travel_date_start", { length: 10 }),
  travelDateEnd: varchar("travel_date_end", { length: 10 }),
  travelDays: integer("travel_days"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveReason: varchar("archive_reason", { length: 16 }).$type<"USER_ARCHIVED" | "DATE_ELAPSED" | null>(),
  // Quick orchestration — soft budget hint mirrored from the conversational
  // setup session. Always nullable; absence means "no budget declared".
  budgetHintAmount: integer("budget_hint_amount"),
  budgetHintCurrency: varchar("budget_hint_currency", { length: 3 }),
  budgetHintCadence: varchar("budget_hint_cadence", { length: 16 })
    .$type<"TOTAL" | "PER_NIGHT" | "PER_PERSON">(),
  // Server-managed pointer to the latest owner-accepted terminal run.
  // Auto-pin only — no manual UI in MVP. ON DELETE SET NULL keeps the
  // column self-healing when the underlying run is purged. We deliberately
  // skip the `.references(...)` callback to break the circular type
  // dependency with `agentTaskRuns.tripId`; the FK constraint lives on
  // the Postgres side (migration 0045).
  pinnedSessionId: uuid("pinned_session_id"),
  pinnedAt: timestamp("pinned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Trip Members ───────────────────────────────────────────────────────────

export const tripMembers = pgTable("trip_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: varchar("role", { length: 32 }).default("MEMBER").notNull(), // "CREATOR","MEMBER"
  isRequired: boolean("is_required").default(true).notNull(),        // required for confirmation quorum
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tripUserUnique: uniqueIndex("trip_members_trip_user_unique").on(table.tripId, table.userId),
}));

// ─── Consent Grants (per trip, per member, per scope) ───────────────────────

export const consentGrants = pgTable("consent_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  scope: consentScopeEnum("scope").notNull(),
  fieldList: jsonb("field_list").$type<string[]>(), // specific fields within scope, e.g. ["interests","accommodation_style"]
  granted: boolean("granted").default(true).notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// ─── Constraint Snapshots (immutable per planning round) ────────────────────

export const constraintSnapshots = pgTable("constraint_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  version: integer("version").notNull(),
  // Frozen authorized data per member at snapshot time
  authorizedData: jsonb("authorized_data").$type<Record<string, unknown>>().notNull(),
  // Trip-level constraints
  departureCities: jsonb("departure_cities").$type<string[]>().notNull(),
  destinationCandidates: jsonb("destination_candidates").$type<string[]>().notNull(),
  travelDateStart: varchar("travel_date_start", { length: 10 }),
  travelDateEnd: varchar("travel_date_end", { length: 10 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tripVersionUnique: uniqueIndex("constraint_snapshots_trip_version_unique").on(table.tripId, table.version),
}));

// ─── Destination Candidates ─────────────────────────────────────────────────

export const destinationCandidates = pgTable("destination_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  city: varchar("city", { length: 128 }).notNull(),
  country: varchar("country", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Itinerary Plans / Plan Versions ────────────────────────────────────────

export const itineraryPlans = pgTable("itinerary_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  snapshotId: uuid("snapshot_id").references(() => constraintSnapshots.id).notNull(),
  version: integer("version").notNull().default(1),
  status: planStatusEnum("status").default("DRAFT").notNull(),
  planData: jsonb("plan_data").$type<Record<string, unknown>>().notNull(), // flights, stays, ground, per-destination
  replacedByPlanId: uuid("replaced_by_plan_id"),
  staleReason: text("stale_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, (table) => ({
  tripVersionUnique: uniqueIndex("itinerary_plans_trip_version_unique").on(table.tripId, table.version),
}));

// ─── Member Confirmations ───────────────────────────────────────────────────

export const memberConfirmations = pgTable("member_confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").references(() => itineraryPlans.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  status: confirmationStatusEnum("status").default("PENDING").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (table) => ({
  planUserUnique: uniqueIndex("member_confirmations_plan_user_unique").on(table.planId, table.userId),
}));

// ─── Visa Readiness Checks ──────────────────────────────────────────────────

export const visaReadinessChecks = pgTable("visa_readiness_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").references(() => itineraryPlans.id, { onDelete: "cascade" }).notNull(),
  snapshotId: uuid("snapshot_id").references(() => constraintSnapshots.id).notNull(),
  memberId: uuid("member_id").references(() => users.id).notNull(),
  destinationCountry: varchar("destination_country", { length: 128 }).notNull(),
  nationality: varchar("nationality", { length: 64 }), // null if not authorized
  status: varchar("status", { length: 32 }).notNull(), // "AUTHORIZED_CHECK","UNAUTHORIZED_NO_CHECK"
  checklist: jsonb("checklist").$type<Array<{ item: string; source: string; uncertainty: string }>>(),
  confidenceLevel: varchar("confidence_level", { length: 32 }), // "HIGH","MEDIUM","LOW","UNCERTAIN"
  source: varchar("source", { length: 256 }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  disclaimer: text("disclaimer"),
});

// ─── Source Evidence ─────────────────────────────────────────────────────────

export const sourceEvidence = pgTable("source_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").references(() => itineraryPlans.id, { onDelete: "cascade" }).notNull(),
  category: varchar("category", { length: 32 }).notNull(), // "flight","stay","ground","visa"
  itemId: varchar("item_id", { length: 128 }).notNull(),
  source: varchar("source", { length: 256 }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb("metadata"),
});

// ─── Provider Offers ────────────────────────────────────────────────────────

export const providerOffers = pgTable("provider_offers", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").references(() => constraintSnapshots.id).notNull(),
  planId: uuid("plan_id").references(() => itineraryPlans.id, { onDelete: "cascade" }),
  category: varchar("category", { length: 32 }).notNull(),
  providerName: varchar("provider_name", { length: 128 }).notNull(),
  searchRunId: uuid("search_run_id"),
  providerOfferId: varchar("provider_offer_id", { length: 256 }),
  currency: varchar("currency", { length: 3 }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // Whether expiresAt is a real supplier commitment ('PROVIDER_VERIFIED') or
  // a locally-invented cache-freshness heuristic ('SYNTHETIC'). NULL means
  // unknown (historical rows predating this column) and is treated
  // identically to 'SYNTHETIC' by the freshness guard — never inferred from
  // provider_name. See flight-offer-freshness-service.ts.
  expiryProvenance: varchar("expiry_provenance", { length: 32 }),
  offerData: jsonb("offer_data").$type<Record<string, unknown>>().notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
});

// Normalized provider-query evidence only. Raw requests/responses and OAuth
// tokens are intentionally never stored here.
export const providerSearchRuns = pgTable("provider_search_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").references(() => constraintSnapshots.id).notNull(),
  agentTaskRunId: uuid("agent_task_run_id").references(() => agentTaskRuns.id, { onDelete: "set null" }),
  category: varchar("category", { length: 32 }).notNull().default("flight"),
  providerName: varchar("provider_name", { length: 128 }).notNull(),
  originId: varchar("origin_id", { length: 16 }),
  destinationId: varchar("destination_id", { length: 128 }),
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
  outcome: varchar("outcome", { length: 16 }).notNull(),
  errorCode: varchar("error_code", { length: 64 }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  snapshotIdx: index("provider_search_runs_snapshot_id_idx").on(table.snapshotId),
  taskIdx: index("provider_search_runs_agent_task_run_id_idx").on(table.agentTaskRunId),
  hotelTaskDestinationUnique: uniqueIndex("provider_search_runs_hotel_task_destination_unique")
    .on(table.agentTaskRunId, table.snapshotId, table.destinationId)
    .where(sql`${table.agentTaskRunId} IS NOT NULL AND ${table.destinationId} IS NOT NULL AND ${table.category} = 'hotel'`),
}));

/**
 * Provider-neutral, bounded search cache shared by hotel quotes, activities,
 * and accommodation discovery. It stores only a SHA-256 fingerprint and a
 * pointer to normalized evidence; supplier payloads, request URLs and user
 * identifiers never enter this table.
 */
export const providerSearchCache = pgTable("provider_search_cache", {
  requestFingerprint: varchar("request_fingerprint", { length: 64 }).primaryKey(),
  providerName: varchar("provider_name", { length: 128 }).notNull(),
  category: varchar("category", { length: 32 }).notNull(),
  state: varchar("state", { length: 16 }).notNull(),
  sourceSearchRunId: uuid("source_search_run_id").references(() => providerSearchRuns.id, { onDelete: "cascade" }),
  errorCode: varchar("error_code", { length: 64 }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  expiresIdx: index("provider_search_cache_expires_at_idx").on(table.expiresAt),
  providerCategoryIdx: index("provider_search_cache_provider_category_idx").on(table.providerName, table.category),
}));

export const tripSearchPreferences = pgTable("trip_search_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  version: integer("version").notNull(),
  tripType: varchar("trip_type", { length: 16 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  adults: integer("adults").notNull(),
  cabin: varchar("cabin", { length: 32 }).notNull(),
  offerFreshnessMinutes: integer("offer_freshness_minutes").notNull(),
  confirmedBy: uuid("confirmed_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tripVersionUnique: uniqueIndex("trip_search_preferences_trip_version_unique").on(table.tripId, table.version),
  tripIdx: index("trip_search_preferences_trip_id_idx").on(table.tripId),
}));

/**
 * Provider-only field authorizations for hotel quote adapters.
 *
 * Stores values that adapters require (e.g. Nuitee `guestNationality`)
 * but must never appear in Profile / shared DTO / LLM prompt / log /
 * trace / metric / audit. `value_encrypted` is opaque ciphertext; only
 * the adapter's per-call KMS path can decrypt it, and that path runs
 * only inside the supplier request — it never logs or persists the
 * plaintext. Adding a new field requires an enum value above AND a
 * server-side adapter that owns the corresponding KMS key.
 *
 * Spec §5.1 — provider-only quote nationality authorization.
 */
export const staySearchProviderAuthorizations = pgTable("stay_search_provider_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  memberId: uuid("member_id").references(() => users.id).notNull(),
  providerName: hotelProviderEnum("provider_name").notNull(),
  field: staySearchProviderAuthorizationFieldEnum("field").notNull(),
  valueEncrypted: text("value_encrypted").notNull(),
  status: staySearchProviderAuthorizationStatusEnum("status").notNull().default("ACTIVE"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  activeUnique: uniqueIndex("stay_search_provider_authorizations_active_unique")
    .on(table.tripId, table.memberId, table.providerName, table.field)
    .where(sql`${table.status} = 'ACTIVE'`),
  tripIdx: index("stay_search_provider_authorizations_trip_idx").on(table.tripId),
  memberIdx: index("stay_search_provider_authorizations_member_idx").on(table.memberId),
}));

export const tripStaySearchPreferences = pgTable("trip_stay_search_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  version: integer("version").notNull(),
  roomCount: integer("room_count").notNull(),
  adultsPerRoom: jsonb("adults_per_room").$type<number[]>().notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  priceDisplayMode: varchar("price_display_mode", { length: 32 }).default("TOTAL_AND_PER_NIGHT").notNull(),
  taxFeeDisclosure: varchar("tax_fee_disclosure", { length: 48 }).default("SHOW_POSSIBLY_EXTRA_WHEN_UNKNOWN").notNull(),
  confirmedBy: uuid("confirmed_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tripVersionUnique: uniqueIndex("trip_stay_search_preferences_trip_version_unique").on(table.tripId, table.version),
  tripIdx: index("trip_stay_search_preferences_trip_id_idx").on(table.tripId),
}));

// ─── Booking Executions ─────────────────────────────────────────────────────

export const bookingExecutions = pgTable("booking_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").references(() => itineraryPlans.id).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id).notNull(),
  orchestrationRequestId: uuid("orchestration_request_id").notNull().unique(),
  status: bookingStatusEnum("status").default("PENDING").notNull(),
  sandboxResults: jsonb("sandbox_results").$type<Record<string, unknown>>(),
  requestedBy: uuid("requested_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// ─── Idempotency Records ────────────────────────────────────────────────────

export const idempotencyRecords = pgTable("idempotency_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: varchar("idempotency_key", { length: 256 }).unique().notNull(),
  entityType: varchar("entity_type", { length: 64 }).notNull(), // "planning","change_event","booking","callback"
  entityId: uuid("entity_id"),
  resultPayload: jsonb("result_payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

// ─── Audit Events ───────────────────────────────────────────────────────────

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  correlationId: uuid("correlation_id").notNull(),
  action: auditActionEnum("action").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  tripId: uuid("trip_id").references(() => sharedTrips.id),
  planId: uuid("plan_id").references(() => itineraryPlans.id),
  summary: jsonb("summary"), // minimal, no PII
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  correlationIdIdx: index("audit_events_correlation_id_idx").on(table.correlationId),
}));

// ─── Outbox Events ──────────────────────────────────────────────────────────

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id").unique().notNull(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: outboxStatusEnum("status").default("PENDING").notNull(),
  // Retry budget and backoff (migration 0030). Without them one event that can
  // never succeed is re-claimed on every pass and starves the rest of the queue.
  attemptCount: integer("attempt_count").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  /** Error class only — a message can quote the payload. */
  lastError: varchar("last_error", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

// ─── Chat Threads (owner-only private conversation) ────────────────────────

export const chatThreads = pgTable("chat_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  // MVP invariant: every thread belongs to exactly one shared trip.
  // Non-trip threads are not permitted; the value list is intentionally
  // a single-entry enum to express that, not for future extensibility.
  scope: chatThreadScopeEnum("scope").notNull().default("TRIP"),
  // Only invitation acceptance (or the idempotent get-or-create route)
  // sets this true.  Enforced by the partial unique index
  // `chat_threads_one_active_default_per_member_trip`.
  isDefault: boolean("is_default").notNull().default(false),
  title: varchar("title", { length: 256 }).notNull(),
  // Title lifecycle metadata (docs/thread-title-lifecycle-implementation.md
  // §5). `title_source` is the AUTO/MANUAL lock: a MANUAL row is never
  // overwritten by the automatic paths. `title_locale` is the language
  // authority for AUTO titles and is NULL for MANUAL ones. `title_updated_at`
  // is the most recent write; NULL until the first write happens.
  titleSource: varchar("title_source", { length: 16 })
    .$type<"AUTO" | "MANUAL">()
    .default("MANUAL")
    .notNull(),
  titleLocale: varchar("title_locale", { length: 8 }).$type<"en" | "zh" | null>(),
  titleUpdatedAt: timestamp("title_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (table) => ({
  ownerIdx: index("chat_threads_owner_user_id_idx").on(table.ownerUserId),
  tripIdx: index("chat_threads_trip_id_idx").on(table.tripId),
  oneActiveDefaultPerMemberTrip: uniqueIndex("chat_threads_one_active_default_per_member_trip")
    .on(table.ownerUserId, table.tripId)
    .where(sql`${table.isDefault} = true AND ${table.archivedAt} IS NULL`),
  tripOwnerActiveIdx: index("chat_threads_trip_owner_active_idx")
    .on(table.tripId, table.ownerUserId, table.createdAt)
    .where(sql`${table.archivedAt} IS NULL`),
}));

export const tripInvitations = pgTable("trip_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  // Legacy account-bound invitations retain their recipient ID. New
  // invitations are email-bound, so an account need not exist at creation.
  invitedUserId: uuid("invited_user_id").references(() => users.id, { onDelete: "cascade" }),
  recipientEmailHash: varchar("recipient_email_hash", { length: 64 }),
  recipientEmailMasked: varchar("recipient_email_masked", { length: 256 }),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  status: tripInvitationStatusEnum("status").notNull().default("PENDING"),
  // SHA-256 of the raw invite token; raw token is returned once at
  // creation time and never persisted.
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  onePendingInvitee: uniqueIndex("trip_invitations_one_pending_invitee")
    .on(table.tripId, table.invitedUserId)
    .where(sql`${table.status} = 'PENDING' AND ${table.invitedUserId} IS NOT NULL`),
  onePendingRecipientEmail: uniqueIndex("trip_invitations_one_pending_recipient_email")
    .on(table.tripId, table.recipientEmailHash)
    .where(sql`${table.status} = 'PENDING' AND ${table.recipientEmailHash} IS NOT NULL`),
  acceptLookupIdx: index("trip_invitations_accept_lookup_idx")
    .on(table.tokenHash, table.status, table.expiresAt),
}));

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").references(() => chatThreads.id, { onDelete: "cascade" }).notNull(),
  // USER rows carry the authenticated owner; ASSISTANT rows deliberately use
  // null so an Agent response is never misrepresented as owner-authored.
  senderUserId: uuid("sender_user_id").references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 16 }).notNull(),
  body: text("body").notNull(),
  redactedSummary: text("redacted_summary"),
  markedSharedByOwner: boolean("marked_shared_by_owner").default(false).notNull(),
  messageSequence: bigint("message_sequence", { mode: "number" }).generatedByDefaultAsIdentity().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  threadIdx: index("chat_messages_thread_id_idx").on(table.threadId),
  threadSequenceIdx: uniqueIndex("chat_messages_thread_sequence_unique").on(table.threadId, table.messageSequence),
}));

/**
 * Server-authoritative hotel search readiness for one private thread.
 *
 * This intentionally stores only the typed provider query fields and the
 * explicit confirmation marker — never chat text, model output, credentials,
 * guest names, nationality, or provider payload.  It lets a later “确认搜索”
 * use the exact fields the owner previously reviewed instead of relying on
 * the model to reconstruct them from transcript context.
 */
/**
 * Free-text memories — the fallback for a highlight the catalogue cannot
 * express. See migration 0059 for why these live apart from
 * `preference_facts`. Bounds (20 rows, 500 characters) are enforced in
 * `free-text-memory-service.ts` so the traveller is told, not truncated.
 */
export const freeTextMemories = pgTable("free_text_memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  title: varchar("title", { length: 80 }).notNull().default("Personal note"),
  content: text("content").notNull(),
  category: varchar("category", { length: 16 }).notNull().default("GENERAL"),
  appliesTo: varchar("applies_to", { length: 16 }).notNull().default("ALL_TRIPS"),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }),
  priority: varchar("priority", { length: 16 }).notNull().default("NORMAL"),
  status: varchar("status", { length: 16 }).notNull().default("ACTIVE"),
  sourceThreadId: uuid("source_thread_id").references(() => chatThreads.id, { onDelete: "set null" }),
  sourceMessageId: uuid("source_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userCreatedIdx: index("free_text_memories_user_created_idx").on(table.userId, table.createdAt),
  userActiveIdx: index("free_text_memories_user_active_idx").on(table.userId, table.status, table.priority),
}));

/**
 * One row once a member has been shown a trip's preference card. See
 * migration 0060 for why this is not inferred from having an override.
 */
export const tripPreferenceCardViews = pgTable("trip_preference_card_views", {
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.tripId, table.userId] }),
}));

export const conversationHotelSearchStates = pgTable("conversation_hotel_search_states", {
  threadId: uuid("thread_id").primaryKey().references(() => chatThreads.id, { onDelete: "cascade" }),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  // Widened from VARCHAR(3): the hotel draft schema (`cityReferenceSchema`)
  // accepts an IATA city code OR a city name up to 64 chars, matching what
  // the location resolver actually resolves ("Kyoto", "京都", "UKY"). A
  // 3-char column silently failed the INSERT for any name-form city,
  // surfacing as a misclassified UPSTREAM_5XX with the real cause (a DB
  // error) hidden behind that generic label.
  cityCode: varchar("city_code", { length: 64 }).notNull(),
  checkIn: date("check_in", { mode: "string" }).notNull(),
  checkOut: date("check_out", { mode: "string" }).notNull(),
  adults: integer("adults").notNull(),
  rooms: integer("rooms").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  /** The USER message which explicitly authorized the provider search. */
  confirmedMessageId: uuid("confirmed_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tripOwnerIdx: index("conversation_hotel_search_states_trip_owner_idx").on(table.tripId, table.ownerUserId),
}));

/** Mirrors `conversationHotelSearchStates` for the `flight.search` capability. */
export const conversationFlightSearchStates = pgTable("conversation_flight_search_states", {
  threadId: uuid("thread_id").primaryKey().references(() => chatThreads.id, { onDelete: "cascade" }),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  originId: varchar("origin_id", { length: 3 }).notNull(),
  destinationId: varchar("destination_id", { length: 3 }).notNull(),
  tripType: varchar("trip_type", { length: 16 }).notNull(),
  departureDate: date("departure_date", { mode: "string" }).notNull(),
  returnDate: date("return_date", { mode: "string" }),
  adults: integer("adults").notNull(),
  cabin: varchar("cabin", { length: 32 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  /** The USER message which explicitly authorized the provider search. */
  confirmedMessageId: uuid("confirmed_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tripOwnerIdx: index("conversation_flight_search_states_trip_owner_idx").on(table.tripId, table.ownerUserId),
}));

// Durable business tasks. Unlike agentRuns below, these rows are authoritative
// lifecycle state and never contain prompt text, partial output, or credentials.
export const agentTaskRuns = pgTable("agent_task_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  operation: agentTaskOperationEnum("operation").notNull(),
  status: agentTaskStatusEnum("status").default("QUEUED").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id).notNull(),
  threadId: uuid("thread_id").references(() => chatThreads.id, { onDelete: "cascade" }),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }),
  snapshotId: uuid("snapshot_id").references(() => constraintSnapshots.id),
  /** Immutable confirmed-search-preference version bound at PLAN/REPLAN acceptance. */
  flightSearchPreferencesVersion: integer("flight_search_preferences_version"),
  /** Immutable confirmed stay-search-preference version bound at acceptance. */
  staySearchPreferencesVersion: integer("stay_search_preferences_version"),
  /**
   * Hotel provider resolved at task acceptance from `HOTEL_PROVIDER`.
   * Nullable: tasks without a hotel capability (e.g. RESEARCH on a flight
   * capability) keep this NULL. Persisted here so a configuration reload
   * never mutates an in-flight task's source. Spec §3.1.
   */
  hotelProvider: hotelProviderEnum("hotel_provider"),
  /** Non-sensitive pointer to the exact Nuitee nationality grant used by this task. */
  hotelQuoteNationalityAuthorizationId: uuid("hotel_quote_nationality_authorization_id")
    .references(() => staySearchProviderAuthorizations.id),
  hotelQuoteNationalityAuthorizationVersion: integer("hotel_quote_nationality_authorization_version"),
  requestId: uuid("request_id").notNull(),
  userMessageId: uuid("user_message_id").references(() => chatMessages.id, { onDelete: "cascade" }),
  assistantMessageId: uuid("assistant_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
  resultPlanId: uuid("result_plan_id").references(() => itineraryPlans.id, { onDelete: "set null" }),
  // ─── Phase 1 — Personal Trip Orchestrator ───────────────────────────────
  // `RESEARCH` (and the columns below) live only on rows with
  // operation === 'RESEARCH'. Other operations keep all three columns NULL.
  // The `research_mode` CHECK is enforced server-side via the Zod
  // `personalResearchKindSchema`; the SQL CHECK is defined in
  // migrations/0033b_personal_research_columns_and_checks.sql so this table
  // shape stays Drizzle-only.
  //
  // `researchResultId` is intentionally declared without an in-Drizzle
  // `.references()` callback: `planningResearchResults` references
  // `agentTaskRuns` (via its own `agentTaskRunId` column), so a mutual
  // reference would form a circular type that Drizzle's inference cannot
  // resolve. The FK is added at the DB layer by migration 0033b.
  researchMode: varchar("research_mode", { length: 16 }),
  requestedCapabilities: jsonb("requested_capabilities").$type<string[]>(),
  researchResultId: uuid("research_result_id"),
  placeSourceId: varchar("place_source_id", { length: 128 }),
  placeName: varchar("place_name", { length: 160 }),
  placeLatitude: doublePrecision("place_latitude"),
  placeLongitude: doublePrecision("place_longitude"),
  placeSourceType: varchar("place_source_type", { length: 16 }),
  intent: text("intent"),
  /**
   * Which surface the traveller typed this turn on: the exploration globe or a
   * trip workspace. Nothing about the trip can tell these apart — a trip
   * created from the globe is listed and openable straight away — so the turn
   * has to carry it. Long-term memory extraction reads it to stay out of
   * exploration; NULL (an older row, or a client that does not send it) reads
   * as exploration, so the failure direction is remembering nothing.
   */
  conversationSurface: varchar("conversation_surface", { length: 32 }),
  /**
   * The trip brief extracted from this turn, awaiting the traveller's
   * confirmation. Kept here because the notification that used to carry it is
   * fire-and-forget: a client that subscribes a moment late never sees it.
   * Still a candidate — nothing reaches `shared_trips` without a confirm.
   */
  tripBriefProposal: jsonb("trip_brief_proposal"),
  /**
   * Personal Research Intent Routing — Phase 0/1.
   * Non-executable persisted draft (kind + capabilities + readiness gaps only).
   * Validation: Zod `persistedResearchIntentDraftSchema`. Never carries
   * coordinates, dates, party size, currency, provider, place IDs, identity,
   * or the original question text. Scope CHECK and pair CHECK are defined
   * in migration `0040_personal_research_intent_draft.sql`.
   * The shape is kept as an inline structural type to match the
   * `traceContext` pattern — the Zod parser is the source of truth at the
   * service boundary and round-trip parity is covered by schema tests.
   * See docs/personal-research-intent-routing-implementation.md §4.1.
   */
  researchIntentDraft: jsonb("research_intent_draft").$type<ResearchIntentDraftShape | null>(),
  researchIntentState: researchIntentStateEnum("research_intent_state"),
  // Bound only on a RESEARCH run created from a confirmed Personal intent.
  // This is the durable link used to load the owner's explicit route choice.
  originatingIntentRunId: uuid("originating_intent_run_id"),
  generationAttempt: integer("generation_attempt").default(0).notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  errorCode: varchar("error_code", { length: 64 }),
  /**
   * W3C trace context carried from the originating HTTP request. The shape
   * is `{ traceparent: string; tracestate?: string; correlationId: string }`
   * and is populated by `acceptConversationTask` from the inbound
   * `RequestContext`. The Worker reconstructs the OTel context from this
   * column via `ctxFromRun` in `apps/api/src/workers/agent-task-worker.ts`.
   * Carries only OTel identifiers — never PII, credentials, or model content.
   */
  /**
   * Upper message_sequence (chat_messages.message_sequence) the Worker may
   * include when building this task's same-thread LLM context. Set at
   * acceptance to the just-inserted USER row's sequence; NULL for legacy
   * rows (resolved at runtime from `user_message_id`, no backfill).
   * PLAN/REPLAN tasks keep NULL.
   */
  contextMaxMessageSequence: bigint("context_max_message_sequence", { mode: "number" }),
  traceContext: jsonb("trace_context").$type<{
    traceparent: string;
    tracestate?: string;
    correlationId: string;
  }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  conversationRequestUnique: uniqueIndex("agent_task_runs_thread_request_unique")
    .on(table.threadId, table.requestId).where(sql`${table.threadId} IS NOT NULL`),
  planningRequestUnique: uniqueIndex("agent_task_runs_trip_request_unique")
    .on(table.tripId, table.requestId).where(sql`${table.tripId} IS NOT NULL`),
  activeConversationUnique: uniqueIndex("agent_task_runs_one_active_conversation")
    .on(table.threadId).where(sql`${table.threadId} IS NOT NULL AND ${table.status} IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')`),
  activePlanningUnique: uniqueIndex("agent_task_runs_one_active_planning")
    .on(table.tripId).where(sql`${table.tripId} IS NOT NULL AND ${table.status} IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED') AND operation IN ('PLAN', 'REPLAN', 'RESEARCH')`),
  createdByIdx: index("agent_task_runs_created_by_idx").on(table.createdByUserId),
  claimIdx: index("agent_task_runs_claim_idx").on(table.status, table.nextAttemptAt, table.leaseExpiresAt, table.createdAt),
  // Index for the supersede-on-new-draft helper. Most threads carry at most
  // one PROPOSED draft at a time, so the index stays small and the lookup
  // inside the draft-insert transaction is O(1).
  threadDraftProposedIdx: index("agent_task_runs_thread_draft_proposed_idx")
    .on(table.threadId).where(sql`${table.researchIntentState} = 'PROPOSED' AND ${table.threadId} IS NOT NULL`),
}));

/**
 * Bounded-at-read replay journal for private Agent SSE. `event` is never a
 * telemetry payload; route-level run authorization protects every read.
 */
export const agentStreamEvents = pgTable("agent_stream_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  runId: uuid("run_id").references(() => agentTaskRuns.id, { onDelete: "cascade" }).notNull(),
  event: jsonb("event").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runIdIdIdx: index("agent_stream_events_run_id_id_idx").on(table.runId, table.id),
}));

// Owner-only confirmation UI generated from one DRAFT conversation turn.
// Unlike `shared_trips.pending_brief_proposal`, this state is scoped to the
// private thread and therefore cannot be projected to other trip members.
export const destinationCueBatches = pgTable("destination_cue_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceRunId: uuid("source_run_id").references(() => agentTaskRuns.id, { onDelete: "cascade" }).notNull().unique(),
  threadId: uuid("thread_id").references(() => chatThreads.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status: destinationCueBatchStatusEnum("status").default("OPEN").notNull(),
  modelVersion: varchar("model_version", { length: 128 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  oneOpenPerThread: uniqueIndex("destination_cue_batches_one_open_per_thread")
    .on(table.threadId).where(sql`${table.status} = 'OPEN'`),
  ownerThreadIdx: index("destination_cue_batches_owner_thread_idx")
    .on(table.ownerUserId, table.threadId, table.createdAt),
}));

export const destinationCueCandidates = pgTable("destination_cue_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").references(() => destinationCueBatches.id, { onDelete: "cascade" }).notNull(),
  ordinal: integer("ordinal").notNull(),
  canonicalCityName: varchar("canonical_city_name", { length: 128 }).notNull(),
  countryCode: varchar("country_code", { length: 2 }).notNull(),
  candidateKeyHash: varchar("candidate_key_hash", { length: 64 }).notNull(),
  candidateIntent: varchar("candidate_intent", { length: 48 })
    .$type<"DESTINATION_INTEREST" | "EXPLICIT_SET_DESTINATION">()
    .default("DESTINATION_INTEREST").notNull(),
  triggerContext: varchar("trigger_context", { length: 48 })
    .$type<"BARE_CITY" | "CITY_EXPLORATION" | "FLIGHT_DESTINATION" | "HOTEL_DESTINATION" | "EXPLICIT_DESTINATION_COMMAND">()
    .default("CITY_EXPLORATION").notNull(),
  status: destinationCueCandidateStatusEnum("status").default("PENDING").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  batchOrdinalUnique: uniqueIndex("destination_cue_candidates_batch_ordinal_unique")
    .on(table.batchId, table.ordinal),
  batchCandidateUnique: uniqueIndex("destination_cue_candidates_batch_key_unique")
    .on(table.batchId, table.candidateKeyHash),
  batchStatusIdx: index("destination_cue_candidates_batch_status_idx")
    .on(table.batchId, table.status, table.ordinal),
}));

// A dismissal is specific to one owner, one draft trip and one canonical
// destination. It records no message text or location coordinates.
export const destinationCueSuppressions = pgTable("destination_cue_suppressions", {
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  candidateKeyHash: varchar("candidate_key_hash", { length: 64 }).notNull(),
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull(),
  lastQualifiedMentionAt: timestamp("last_qualified_mention_at", { withTimezone: true }).notNull(),
  qualifiedMentionCount: integer("qualified_mention_count").default(0).notNull(),
  version: integer("version").default(1).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.ownerUserId, table.tripId, table.candidateKeyHash] }),
}));

// V2 prompt fatigue is Trip-wide rather than tied to one city. The timestamps
// stay UTC; dismissalDay is derived using the user-supplied, validated IANA
// timezone so "three times today" follows the traveller's calendar day.
export const destinationCuePromptPolicies = pgTable("destination_cue_prompt_policies", {
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  dismissalDay: varchar("dismissal_day", { length: 10 }),
  dailyDismissalCount: integer("daily_dismissal_count").default(0).notNull(),
  mutedUntil: timestamp("muted_until", { withTimezone: true }),
  timezone: varchar("timezone", { length: 64 }).default("UTC").notNull(),
  version: integer("version").default(1).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.ownerUserId, table.tripId] }),
  tripOwnerIdx: index("destination_cue_prompt_policies_trip_idx").on(table.tripId, table.ownerUserId),
}));

// ─── Agent Runs (LLM gateway observability) ─────────────────────────────────

export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  skillName: varchar("skill_name", { length: 128 }).notNull(),
  agentName: varchar("agent_name", { length: 32 }).notNull(),
  modelName: varchar("model_name", { length: 128 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
  outputHash: varchar("output_hash", { length: 64 }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  errorCode: varchar("error_code", { length: 64 }),
  tokens: jsonb("tokens").$type<{ prompt: number; completion: number; total: number } | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Prompt Versions ────────────────────────────────────────────────────────

export const promptVersions = pgTable("prompt_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 128 }).notNull(),
  version: varchar("version", { length: 64 }).notNull(),
  templateHash: varchar("template_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  nameVersionUnique: uniqueIndex("prompt_versions_name_version_unique").on(table.name, table.version),
}));

// ─── Location Introduction Cache (S4) ─────────────────────────────────────────────────────────────────────
// Anonymous, shared cache for short destination intros. No user/Trip/thread
// identifiers ever land in this row.
export const locationIntroductionCache = pgTable("location_introduction_cache", {
  cacheKey: varchar("cache_key", { length: 64 }).primaryKey(),
  canonicalPlaceId: varchar("canonical_place_id", { length: 128 }).notNull(),
  locale: varchar("locale", { length: 16 }).notNull(),
  contentVersion: varchar("content_version", { length: 64 }).notNull(),
  status: locationIntroductionStatusEnum("status").notNull(),
  content: text("content"),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  generationLeaseToken: uuid("generation_lease_token"),
  generationLeaseExpiresAt: timestamp("generation_lease_expires_at", { withTimezone: true }),
  modelName: varchar("model_name", { length: 128 }),
  promptVersion: varchar("prompt_version", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Team Agent 协作编排 Phase 1+2 (doc: docs/team-agent-orchestration-implementation.md) ──
// Drizzle 镜像；migration 文件 0021/0022 已定义结构与索引。

// Phase: member conversation handoff (spec docs/member-conversation-handoff-implementation.md §4.1).
// Legacy rows keep batchId / originThreadId / originRunId = NULL with candidateVersion = 1; only
// PENDING PERSONAL_AGENT rows carry the origin trio so they can be confirmed
// safely. Terminal rows may have provenance redacted when their private
// source thread is deleted (migrations 0057/0058).
export const tripConstraintProposals = pgTable("trip_constraint_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  fieldKey: varchar("field_key", { length: 64 }).notNull(),
  valueJson: jsonb("value_json").notNull().$type<Record<string, unknown>>(),
  valueHash: varchar("value_hash", { length: 64 }).notNull(),
  strength: constraintStrengthEnum("strength").notNull(),
  proposedVisibility: constraintVisibilityEnum("proposed_visibility").notNull(),
  sourceKind: varchar("source_kind", { length: 16 }).notNull().$type<"PERSONAL_AGENT" | "OWNER_FORM">(),
  status: constraintProposalStatusEnum("status").notNull().default("PENDING"),
  batchId: uuid("batch_id"),
  originThreadId: uuid("origin_thread_id").references(() => chatThreads.id, { onDelete: "set null" }),
  originRunId: uuid("origin_run_id").references(() => agentTaskRuns.id, { onDelete: "set null" }),
  candidateVersion: integer("candidate_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => ({
  tripOwnerFieldHashPendingUnique: uniqueIndex("trip_constraint_proposals_pending_unique")
    .on(table.tripId, table.ownerUserId, table.fieldKey, table.valueHash)
    .where(sql`status = 'PENDING'`),
  tripOwnerStatusIdx: index("trip_constraint_proposals_trip_owner_idx")
    .on(table.tripId, table.ownerUserId, table.status),
  batchFieldUnique: uniqueIndex("trip_constraint_proposals_batch_field_unique")
    .on(table.tripId, table.batchId, table.fieldKey)
    .where(sql`batch_id IS NOT NULL AND source_kind = 'PERSONAL_AGENT'`),
  batchIdx: index("trip_constraint_proposals_batch_idx")
    .on(table.batchId)
    .where(sql`batch_id IS NOT NULL`),
  originThreadIdx: index("trip_constraint_proposals_origin_thread_idx")
    .on(table.originThreadId)
    .where(sql`origin_thread_id IS NOT NULL`),
}));

export const tripConstraintFacts = pgTable("trip_constraint_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  fieldKey: varchar("field_key", { length: 64 }).notNull(),
  valueJson: jsonb("value_json").notNull().$type<Record<string, unknown>>(),
  valueHash: varchar("value_hash", { length: 64 }).notNull(),
  strength: constraintStrengthEnum("strength").notNull(),
  visibility: constraintVisibilityEnum("visibility").notNull(),
  kind: tripConstraintKindEnum("kind").default("MEMBER_CONSTRAINT").notNull(),
  revision: integer("revision").notNull(),
  sourceProposalId: uuid("source_proposal_id").references(() => tripConstraintProposals.id, { onDelete: "set null" }),
  status: varchar("status", { length: 16 }).notNull().$type<"ACTIVE" | "SUPERSEDED" | "REVOKED">(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => ({
  // Active uniqueness is per kind — see migration 0028. A single index across
  // every kind would stop a member holding both an orchestration constraint
  // and a personal override on one field.
  memberActiveUnique: uniqueIndex("trip_constraint_facts_member_active_unique")
    .on(table.tripId, table.ownerUserId, table.fieldKey)
    .where(sql`status = 'ACTIVE' AND kind = 'MEMBER_CONSTRAINT'`),
  overrideActiveUnique: uniqueIndex("trip_constraint_facts_override_active_unique")
    .on(table.tripId, table.ownerUserId, table.fieldKey)
    .where(sql`status = 'ACTIVE' AND kind = 'PERSONAL_OVERRIDE'`),
  groupDecisionActiveUnique: uniqueIndex("trip_constraint_facts_group_decision_unique")
    .on(table.tripId, table.fieldKey)
    .where(sql`status = 'ACTIVE' AND kind = 'GROUP_DECISION'`),
  tripOwnerFieldIdx: index("trip_constraint_facts_trip_owner_field_idx")
    .on(table.tripId, table.ownerUserId, table.fieldKey),
  tripVisibilityIdx: index("trip_constraint_facts_trip_visibility_idx")
    .on(table.tripId, table.visibility),
}));

export const planAdoptionVotes = pgTable("plan_adoption_votes", {
  planId: uuid("plan_id").references(() => itineraryPlans.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  decision: planAdoptionDecisionEnum("decision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: uniqueIndex("plan_adoption_votes_pkey").on(table.planId, table.userId),
  planIdx: index("plan_adoption_votes_plan_idx").on(table.planId),
}));

// ─── Global POI & ground mobility (spec docs/ground-mobility-implementation.md §4) ──
// Drizzle 镜像；migration 0023_poi_route_mobility.sql 已定义 enum、表与索引。
//
// 不变量：
//  * trip_places 坐标仅存 longitude/latitude，绝不进 telemetry/audit/log；
//    OWNER_PRIVATE place 永不进入 Shared snapshot。
//  * navigation_route_evidence 是受保护的 Trip 数据，encoded_geometry 默认不进
//    LLM/日志/trace/metric/audit summary。
//  * planning_research_results 不是 itinerary_plan，无 booking authority。

export const tripPlaceVisibilityEnum = pgEnum("trip_place_visibility", [
  "OWNER_PRIVATE",
  "TEAM_VISIBLE",
  "ORCHESTRATOR_CONFIDENTIAL",
]);

export const tripPlaceStatusEnum = pgEnum("trip_place_status", [
  "PROPOSED",
  "ACTIVE",
  "REVOKED",
]);

export const tripPlaceKindEnum = pgEnum("trip_place_kind", [
  "ATTRACTION",
  "HOTEL",
  "RESTAURANT",
  "TRANSPORT_HUB",
  "OTHER",
]);

export const navigationRouteModeEnum = pgEnum("navigation_route_mode", [
  "WALK",
  "DRIVE",
  "CYCLE",
]);

export const researchResultStatusEnum = pgEnum("research_result_status", [
  "COMPLETE",
  "COMPLETED_WITH_GAPS",
]);

export const mobilityServiceTypeEnum = pgEnum("mobility_service_type", [
  "TAXI",
  "TRANSFER",
  "CHARTER",
  "RENTAL",
]);

export const tripPlaces = pgTable("trip_places", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  version: integer("version").notNull().default(1),
  visibility: tripPlaceVisibilityEnum("visibility").notNull(),
  status: tripPlaceStatusEnum("status").notNull().default("PROPOSED"),
  kind: tripPlaceKindEnum("kind").notNull(),
  displayName: varchar("display_name", { length: 256 }).notNull(),
  countryCode: varchar("country_code", { length: 2 }),
  cityName: varchar("city_name", { length: 128 }),
  longitude: doublePrecision("longitude"),
  latitude: doublePrecision("latitude"),
  source: varchar("source", { length: 256 }).notNull(),
  providerPlaceId: varchar("provider_place_id", { length: 256 }),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  createdFromRunId: uuid("created_from_run_id").references(() => agentTaskRuns.id, { onDelete: "set null" }),
  supersededById: uuid("superseded_by_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  activeUnique: uniqueIndex("trip_places_active_unique")
    .on(table.tripId, table.displayName, table.kind, table.source)
    .where(sql`status = 'ACTIVE'`),
  tripStatusIdx: index("trip_places_trip_status_idx").on(table.tripId, table.status),
  tripVisibilityIdx: index("trip_places_trip_visibility_idx").on(table.tripId, table.visibility),
  runIdx: index("trip_places_run_idx").on(table.createdFromRunId)
    .where(sql`created_from_run_id IS NOT NULL`),
}));

/** Explicit owner selection for one navigation/mobility intent draft. */
export const researchRouteSelections = pgTable("research_route_selections", {
  intentRunId: uuid("intent_run_id").primaryKey().references(() => agentTaskRuns.id, { onDelete: "cascade" }),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  originPlaceId: uuid("origin_place_id").references(() => tripPlaces.id, { onDelete: "restrict" }).notNull(),
  destinationPlaceId: uuid("destination_place_id").references(() => tripPlaces.id, { onDelete: "restrict" }).notNull(),
  mode: navigationRouteModeEnum("mode").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tripOwnerIdx: index("research_route_selections_trip_owner_idx").on(table.tripId, table.ownerUserId),
}));

/**
 * Per-intent-run conversational setup scratchpad — removed in
 * migrations/0049_drop_personal_research_setup.sql. The LLM-driven
 * Personal Research tool loop (Phase 4) replaces this with
 * conversational state in chat + the existing `personal_research_evidence`
 * table for typed outputs.
 */
// personalResearchSetupSessions table intentionally deleted.

export const navigationRouteEvidence = pgTable("navigation_route_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  searchRunId: uuid("search_run_id").references(() => providerSearchRuns.id, { onDelete: "cascade" }).notNull(),
  snapshotId: uuid("snapshot_id").references(() => constraintSnapshots.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  originPlaceId: uuid("origin_place_id").references(() => tripPlaces.id, { onDelete: "restrict" }).notNull(),
  destinationPlaceId: uuid("destination_place_id").references(() => tripPlaces.id, { onDelete: "restrict" }).notNull(),
  mode: navigationRouteModeEnum("mode").notNull(),
  distanceMeters: doublePrecision("distance_meters").notNull(),
  durationSeconds: doublePrecision("duration_seconds").notNull(),
  steps: jsonb("steps").$type<Array<Record<string, unknown>>>().notNull(),
  encodedGeometry: text("encoded_geometry").notNull(),
  source: varchar("source", { length: 256 }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  refreshAfter: timestamp("refresh_after", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  snapshotIdx: index("navigation_route_evidence_snapshot_idx").on(table.snapshotId, table.tripId),
  pairIdx: index("navigation_route_evidence_pair_idx").on(table.originPlaceId, table.destinationPlaceId, table.mode),
  refreshIdx: index("navigation_route_evidence_refresh_idx").on(table.refreshAfter),
}));

export const planningResearchResults = pgTable("planning_research_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  snapshotId: uuid("snapshot_id").references(() => constraintSnapshots.id, { onDelete: "cascade" }).notNull(),
  agentTaskRunId: uuid("agent_task_run_id").references(() => agentTaskRuns.id, { onDelete: "set null" }),
  status: researchResultStatusEnum("status").notNull(),
  serviceGaps: jsonb("service_gaps").$type<Array<Record<string, unknown>>>().notNull().default([]),
  resultPlanId: uuid("result_plan_id").references(() => itineraryPlans.id, { onDelete: "set null" }),
  /**
   * Why this run produced a summary rather than a plan. NULL on rows written
   * before the column existed, and on rows that do carry a plan. Values are
   * constrained by `planning_research_results_summary_reason_check`.
   */
  summaryReason: text("summary_reason").$type<
    "NO_CITABLE_EVIDENCE" | "TOOL_BUDGET_EXHAUSTED" | "PLAN_SCHEMA_UNMET" | "RESEARCH_MATRIX_INCOMPLETE"
  >(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniquePerTask: uniqueIndex("planning_research_results_unique_per_task").on(table.agentTaskRunId)
    .where(sql`agent_task_run_id IS NOT NULL`),
  tripSnapshotIdx: index("planning_research_results_trip_snapshot_idx").on(table.tripId, table.snapshotId),
  statusIdx: index("planning_research_results_status_idx").on(table.tripId, table.status),
}));

// ─── DRAFT Personal Research (docs/draft-personal-research-implementation.md §3.2) ──
//
// Owner-only thin evidence projection for PERSONAL_RESEARCH durable tasks.
// Structurally independent of every snapshot-bound Shared evidence table —
// the snapshot_id NOT NULL invariants on `provider_offers`,
// `provider_search_runs`, `itinerary_plans`, `visa_readiness_checks`,
// `navigation_route_evidence`, and `planning_research_results` are NOT
// relaxed. `result_json` is a Zod-validated bounded summary; raw provider
// payloads, chat text, nationality, passport, and document fields never
// land here.
export const personalResearchOutcomeEnum = pgEnum("personal_research_outcome", [
  "AVAILABLE",
  "UNAVAILABLE",
  "EXPIRED",
]);

// Capability enum. Visa is intentionally NOT included — stage 4 of spec §3.5
// requires real VisaProvider contract / DPA / credentials / audit / sandbox
// validation and must ship as its own migration + PR. New capabilities are
// added one per row (Postgres cannot batch ALTER TYPE ... ADD VALUE), and the
// capability allow-list in apps/api/src/config/personal-research-allowed-capabilities.ts
// must be updated in the same change.
export const personalResearchCapabilityEnum = pgEnum("personal_research_capability", [
  "flight.search",
  "hotel.search",
  "accommodation.discovery",
  "activities.search",
  "places.search",
  "navigation.route",
  "mobility.search",
]);

export const personalResearchEvidence = pgTable("personal_research_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => agentTaskRuns.id, { onDelete: "cascade" }),
  tripId: uuid("trip_id").notNull().references(() => sharedTrips.id, { onDelete: "cascade" }),
  threadId: uuid("thread_id").notNull().references(() => chatThreads.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  capability: personalResearchCapabilityEnum("capability").notNull(),
  outcome: personalResearchOutcomeEnum("outcome").notNull(),
  providerName: varchar("provider_name", { length: 64 }).notNull(),
  source: varchar("source", { length: 128 }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  resultJson: jsonb("result_json").$type<Record<string, unknown>>().notNull(),
  // Hash of the canonicalised draft: what was searched, so a retry of the
  // same search collapses onto one row while two different searches in the
  // same turn both keep theirs. See migration 0056.
  requestFingerprint: text("request_fingerprint").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  runSearchUnique: uniqueIndex("personal_research_evidence_run_search_unique")
    .on(table.runId, table.capability, table.requestFingerprint),
  tripCreatedIdx: index("personal_research_evidence_trip_created_idx")
    .on(table.tripId, table.createdAt),
  ownerCreatedIdx: index("personal_research_evidence_owner_created_idx")
    .on(table.ownerUserId, table.createdAt),
}));

// Immutable, owner-confirmed input for a PERSONAL_RESEARCH task. Keeping the
// input beside the durable task (rather than re-reading the mutable
// CONVERSATION draft) makes the Worker execute exactly what the owner saw at
// confirmation time.
export const personalResearchRequests = pgTable("personal_research_requests", {
  runId: uuid("run_id").primaryKey().references(() => agentTaskRuns.id, { onDelete: "cascade" }),
  originatingIntentRunId: uuid("originating_intent_run_id").notNull().references(() => agentTaskRuns.id, { onDelete: "cascade" }),
  capability: personalResearchCapabilityEnum("capability").notNull(),
  inputJson: jsonb("input_json").$type<Record<string, unknown>>().notNull(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  version: integer("version").default(1).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Flight / Hotel Offer Cue (docs/flight-offer-cue-model-draft.md,
//     docs/hotel-offer-cue-model-draft.md) ──────────────────────────────────
// Personal-only state machine. Never writes shared_trips.constraint_snapshot,
// never grants booking authority, never wakes the Shared agent. Phase 1
// strictly DRAFT Trip creator's private thread — the service layer
// additionally asserts trip.status === "DRAFT" && createdBy === owner.

// Bounded projection of a Personal Research offer set with opaque, server-
// issued identity. The browser sees `candidateRef` (uuid) and ordinal only;
// providerOfferId, raw payload, coordinates and PII are stripped at the
// executor boundary. `visible_before_message_sequence` records the upper-
// bound `chat_messages.message_sequence` of the assistant message that
// streamed the offer set; the resolver excludes candidates whose
// visible_before_message_sequence is >= the user's current message
// sequence, so the model never sees offers the traveller has not actually
// seen.
export const personalResearchOfferCandidates = pgTable("personal_research_offer_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  evidenceId: uuid("evidence_id").references(() => personalResearchEvidence.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  threadId: uuid("thread_id").references(() => chatThreads.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  capability: offerCueCapabilityEnum("capability").notNull(),
  offerSetId: uuid("offer_set_id").notNull(),
  routeKey: varchar("route_key", { length: 64 }),
  stayKey: varchar("stay_key", { length: 64 }),
  ordinal: integer("ordinal").notNull(),
  normalizedOfferJson: jsonb("normalized_offer_json").$type<Record<string, unknown>>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  visibleBeforeMessageSequence: bigint("visible_before_message_sequence", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  setOrdinalUnique: uniqueIndex("personal_research_offer_candidates_set_ord").on(table.offerSetId, table.ordinal),
  setRouteUnique: uniqueIndex("personal_research_offer_candidates_set_route")
    .on(table.offerSetId, table.routeKey)
    .where(sql`${table.capability} = 'flight' AND ${table.routeKey} IS NOT NULL`),
  setStayUnique: uniqueIndex("personal_research_offer_candidates_set_stay")
    .on(table.offerSetId, table.stayKey)
    .where(sql`${table.capability} = 'hotel' AND ${table.stayKey} IS NOT NULL`),
  tripIdx: index("personal_research_offer_candidates_trip_idx").on(table.tripId, table.capability, table.createdAt),
  expiresIdx: index("personal_research_offer_candidates_expires_idx").on(table.expiresAt).where(sql`${table.expiresAt} IS NOT NULL`),
  evidenceIdx: index("personal_research_offer_candidates_evidence_idx").on(table.evidenceId),
}));

// One batch per source run. The partial unique index keeps at most one OPEN
// batch per (thread, capability) so Flight and Hotel can each be OPEN
// simultaneously but never two of the same capability on the same thread.
export const offerCueBatches = pgTable("offer_cue_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceRunId: uuid("source_run_id").references(() => agentTaskRuns.id, { onDelete: "cascade" }).notNull().unique(),
  threadId: uuid("thread_id").references(() => chatThreads.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  capability: offerCueCapabilityEnum("capability").notNull(),
  sourceMessageId: uuid("source_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
  offerSetId: uuid("offer_set_id").notNull(),
  modelVersion: varchar("model_version", { length: 128 }).notNull(),
  promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
  status: offerCueBatchStatusEnum("status").default("OPEN").notNull(),
  version: integer("version").default(1).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  oneOpenPerThreadCap: uniqueIndex("offer_cue_batches_one_open_per_thread_cap")
    .on(table.threadId, table.capability).where(sql`${table.status} = 'OPEN'`),
  ownerThreadIdx: index("offer_cue_batches_owner_thread_idx")
    .on(table.ownerUserId, table.threadId, table.capability, table.createdAt),
}));

// One row per candidate within a batch. Resolved to ACCEPTED or DISMISSED by
// the act-on-candidate state machine; an empty batch flips the batch status
// to RESOLVED.
export const offerCueCandidates = pgTable("offer_cue_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").references(() => offerCueBatches.id, { onDelete: "cascade" }).notNull(),
  personalOfferCandidateId: uuid("personal_offer_candidate_id").references(() => personalResearchOfferCandidates.id, { onDelete: "cascade" }).notNull(),
  intent: offerCueCandidateIntentEnum("intent").notNull(),
  ordinal: integer("ordinal").notNull(),
  status: offerCueCandidateStatusEnum("status").default("PENDING").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  batchOrdinalUnique: uniqueIndex("offer_cue_candidates_batch_ordinal_unique").on(table.batchId, table.ordinal),
  batchCandidateUnique: uniqueIndex("offer_cue_candidates_batch_candidate_unique").on(table.batchId, table.personalOfferCandidateId),
  batchStatusIdx: index("offer_cue_candidates_batch_status_idx").on(table.batchId, table.status, table.ordinal),
}));

// Prompt fatigue is Trip-wide, scoped per (owner, trip, capability) so
// Flight and Hotel count independently — same shape as
// destination_cue_prompt_policies but with capability in the primary key.
export const offerCuePromptPolicies = pgTable("offer_cue_prompt_policies", {
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  capability: offerCueCapabilityEnum("capability").notNull(),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  dismissalDay: varchar("dismissal_day", { length: 10 }),
  dailyDismissalCount: integer("daily_dismissal_count").default(0).notNull(),
  mutedUntil: timestamp("muted_until", { withTimezone: true }),
  timezone: varchar("timezone", { length: 64 }).default("UTC").notNull(),
  version: integer("version").default(1).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.ownerUserId, table.tripId, table.capability] }),
  tripIdx: index("offer_cue_prompt_policies_trip_idx").on(table.tripId, table.ownerUserId, table.capability),
}));

// The owner's confirmed personal offer candidate for one (trip, capability,
// scopeKey). scopeKey = routeKey (flight) or stayKey (hotel). At most one
// ACTIVE row per scope; accept supersedes any prior ACTIVE in the same scope
// atomically. Never projected into constraint_snapshot; never consumed by
// Shared agent or booking authority — see plan §"No-Snapshot guarantee".
export const personalOfferSelections = pgTable("personal_offer_selections", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  threadId: uuid("thread_id").references(() => chatThreads.id, { onDelete: "cascade" }).notNull(),
  tripId: uuid("trip_id").references(() => sharedTrips.id, { onDelete: "cascade" }).notNull(),
  capability: offerCueCapabilityEnum("capability").notNull(),
  personalOfferCandidateId: uuid("personal_offer_candidate_id").references(() => personalResearchOfferCandidates.id, { onDelete: "cascade" }).notNull(),
  scopeKey: varchar("scope_key", { length: 64 }).notNull(),
  status: personalOfferSelectionStatusEnum("status").default("ACTIVE").notNull(),
  selectedAt: timestamp("selected_at", { withTimezone: true }).defaultNow().notNull(),
  version: integer("version").default(1).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tripIdx: index("personal_offer_selections_trip_idx").on(table.tripId, table.ownerUserId, table.capability, table.status),
  candidateIdx: index("personal_offer_selections_candidate_idx").on(table.personalOfferCandidateId),
}));
