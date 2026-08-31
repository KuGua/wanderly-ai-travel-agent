import { sql } from "drizzle-orm";
import { pgTable, uuid, varchar, text, timestamp, date, jsonb, boolean, integer, bigint, doublePrecision, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";

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
export const agentTaskOperationEnum = pgEnum("agent_task_operation", ["CONVERSATION", "PLAN", "REPLAN", "RESEARCH"]);
export const agentTaskStatusEnum = pgEnum("agent_task_status", [
  "QUEUED", "RUNNING", "CANCEL_REQUESTED", "COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED", "STALE",
]);
export const auditActionEnum = pgEnum("audit_action", [
  "PROFILE_CREATE", "PROFILE_UPDATE", "PROFILE_DELETE",
  "TRIP_CREATE", "TRIP_JOIN",
  "CONSENT_GRANT", "CONSENT_REVOKE",
  "PLAN_CREATE", "PLAN_STALE", "PLAN_REPLAN", "PLAN_RESTART",
  "CONFIRMATION_SET",
  "BOOKING_SUBMIT", "BOOKING_RESULT",
  "CHANGE_EVENT",
  "VISA_CHECK",
  "CHAT_THREAD_CREATE", "CHAT_THREAD_DELETE", "CHAT_MESSAGE_APPEND",
  "TRIP_INVITATION_CREATE", "TRIP_INVITATION_ACCEPT",
  "TRIP_INVITATION_REVOKE", "TRIP_INVITATION_DECLINE", "TRIP_DEFAULT_THREAD_PROVISION",
  "EXPLORATION_START", "TRIP_ACTIVATE", "TRIP_TITLE_UPDATE", "TRIP_DRAFT_BRIEF_UPDATE",
  "SKILL_INVOKE", "AGENT_RUN", "AGENT_TASK",
  "FLIGHT_SEARCH_REQUESTED", "FLIGHT_SEARCH_COMPLETED", "FLIGHT_SEARCH_UNAVAILABLE",
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
  "PREFERENCE_FACT_UPDATE", "PREFERENCE_FACT_DELETE",
  "TRIP_MEMORY_UPDATE", "TRIP_MEMORY_DELETE",
  "MEMORY_PROJECTION_CREATE", "MEMORY_INVALIDATION",
  // Hotel provider switching (docs/nuitee-serpapi-hotel-provider-switching-implementation.md §5):
  "HOTEL_PROVIDER_GRANTED", "HOTEL_PROVIDER_REVOKED", "HOTEL_PROVIDER_SWITCH_BLOCKED",
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
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 256 }).notNull(),
  nameSource: varchar("name_source", { length: 16 }).$type<"AUTO" | "MANUAL">().default("MANUAL").notNull(),
  titleLocale: varchar("title_locale", { length: 8 }).$type<"en" | "zh" | null>(),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  status: tripStatusEnum("status").default("PLANNING").notNull(),
  departureCities: jsonb("departure_cities").$type<string[]>().notNull(),   // ["Shanghai","San Francisco"]
  destinationCandidates: jsonb("destination_candidates").$type<string[]>().notNull(), // ["Tokyo","Bangkok","Seoul"]
  travelDateStart: varchar("travel_date_start", { length: 10 }),
  travelDateEnd: varchar("travel_date_end", { length: 10 }),
  travelDays: integer("travel_days"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  archiveReason: varchar("archive_reason", { length: 16 }).$type<"USER_ARCHIVED" | "DATE_ELAPSED" | null>(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => ({
  tripOwnerFieldHashPendingUnique: uniqueIndex("trip_constraint_proposals_pending_unique")
    .on(table.tripId, table.ownerUserId, table.fieldKey, table.valueHash)
    .where(sql`status = 'PENDING'`),
  tripOwnerStatusIdx: index("trip_constraint_proposals_trip_owner_idx")
    .on(table.tripId, table.ownerUserId, table.status),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  uniquePerTask: uniqueIndex("planning_research_results_unique_per_task").on(table.agentTaskRunId)
    .where(sql`agent_task_run_id IS NOT NULL`),
  tripSnapshotIdx: index("planning_research_results_trip_snapshot_idx").on(table.tripId, table.snapshotId),
  statusIdx: index("planning_research_results_status_idx").on(table.tripId, table.status),
}));
