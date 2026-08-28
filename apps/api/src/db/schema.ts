import { sql } from "drizzle-orm";
import { pgTable, uuid, varchar, text, timestamp, jsonb, boolean, integer, bigint, doublePrecision, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const tripStatusEnum = pgEnum("trip_status", ["DRAFT", "PLANNING", "CONFIRMED", "BOOKED", "CANCELLED", "STALE"]);
export const planStatusEnum = pgEnum("plan_status", ["DRAFT", "ACTIVE", "STALE", "SUPERSEDED"]);
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
export const outboxStatusEnum = pgEnum("outbox_status", ["PENDING", "PROCESSED", "FAILED"]);
export const agentTaskOperationEnum = pgEnum("agent_task_operation", ["CONVERSATION", "PLAN", "REPLAN"]);
export const agentTaskStatusEnum = pgEnum("agent_task_status", [
  "QUEUED", "RUNNING", "CANCEL_REQUESTED", "COMPLETED", "FAILED", "CANCELLED", "STALE",
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
  "TRIP_INVITATION_REVOKE", "TRIP_DEFAULT_THREAD_PROVISION",
  "EXPLORATION_START", "TRIP_ACTIVATE", "TRIP_TITLE_UPDATE", "TRIP_DRAFT_BRIEF_UPDATE",
  "SKILL_INVOKE", "AGENT_RUN", "AGENT_TASK",
  "LOCATION_INTRODUCTION_REGISTER",
]);

// Chat thread scope — MVP allows only TRIP-scoped threads; adding new
// scopes later requires explicit schema + migration work.
export const chatThreadScopeEnum = pgEnum("chat_thread_scope", ["TRIP"]);

export const tripInvitationStatusEnum = pgEnum("trip_invitation_status", [
  "PENDING", "ACCEPTED", "REVOKED", "EXPIRED",
]);

// S4 / docs/location-introduction-cache-implementation.md §4.  Shared,
// non-personalized destination-introduction cache.  No user/Trip/thread
// identifiers are stored here.
export const locationIntroductionStatusEnum = pgEnum("location_introduction_status", [
  "GENERATING",
  "READY",
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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
  offerData: jsonb("offer_data").$type<Record<string, unknown>>().notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
});

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
  invitedUserId: uuid("invited_user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  status: tripInvitationStatusEnum("status").notNull().default("PENDING"),
  // SHA-256 of the raw invite token; raw token is returned once at
  // creation time and never persisted.
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  onePendingInvitee: uniqueIndex("trip_invitations_one_pending_invitee")
    .on(table.tripId, table.invitedUserId)
    .where(sql`${table.status} = 'PENDING'`),
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
  requestId: uuid("request_id").notNull(),
  userMessageId: uuid("user_message_id").references(() => chatMessages.id, { onDelete: "cascade" }),
  assistantMessageId: uuid("assistant_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
  resultPlanId: uuid("result_plan_id").references(() => itineraryPlans.id, { onDelete: "set null" }),
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
    .on(table.tripId).where(sql`${table.tripId} IS NOT NULL AND ${table.status} IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')`),
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

// ─── Location Introduction Catalog Overrides (S4 admin registration) ───────────
// Runtime-registered entries added by an authenticated admin via
// `POST /api/v1/admin/location-introduction/entries`. The DB row is
// authoritative for the live process; `data/location-introduction/catalog.json`
// is rewritten in lockstep so cold-start deploys see the same set.
export const locationIntroductionCatalogOverrides = pgTable("location_introduction_catalog_overrides", {
  sourceId: varchar("source_id", { length: 128 }).primaryKey(),
  canonicalPlaceId: varchar("canonical_place_id", { length: 128 }).notNull(),
  name: varchar("name", { length: 256 }).notNull(),
  country: varchar("country", { length: 128 }).notNull(),
  countryCode: varchar("country_code", { length: 8 }).notNull(),
  admin1: varchar("admin1", { length: 128 }).notNull(),
  admin1Code: varchar("admin1_code", { length: 64 }).notNull(),
  nearestCity: varchar("nearest_city", { length: 128 }).notNull(),
  nearestCityLongitude: doublePrecision("nearest_city_longitude").notNull(),
  nearestCityLatitude: doublePrecision("nearest_city_latitude").notNull(),
  datasetVersion: varchar("dataset_version", { length: 64 }).notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
