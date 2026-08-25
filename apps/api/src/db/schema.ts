import { pgTable, uuid, varchar, text, timestamp, jsonb, boolean, integer, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const tripStatusEnum = pgEnum("trip_status", ["PLANNING", "CONFIRMED", "BOOKED", "CANCELLED", "STALE"]);
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
export const auditActionEnum = pgEnum("audit_action", [
  "PROFILE_CREATE", "PROFILE_UPDATE", "PROFILE_DELETE",
  "TRIP_CREATE", "TRIP_JOIN",
  "CONSENT_GRANT", "CONSENT_REVOKE",
  "PLAN_CREATE", "PLAN_STALE", "PLAN_REPLAN", "PLAN_RESTART",
  "CONFIRMATION_SET",
  "BOOKING_SUBMIT", "BOOKING_RESULT",
  "CHANGE_EVENT",
  "VISA_CHECK",
  "SKILL_INVOKE", "AGENT_RUN",
]);

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: varchar("external_id", { length: 128 }).unique().notNull(), // Verified Cognito subject
  displayName: varchar("display_name", { length: 128 }).notNull(),
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
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  status: tripStatusEnum("status").default("PLANNING").notNull(),
  departureCities: jsonb("departure_cities").$type<string[]>().notNull(),   // ["Shanghai","San Francisco"]
  destinationCandidates: jsonb("destination_candidates").$type<string[]>().notNull(), // ["Tokyo","Bangkok","Seoul"]
  travelDateStart: varchar("travel_date_start", { length: 10 }),
  travelDateEnd: varchar("travel_date_end", { length: 10 }),
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
  source: varchar("source", { length: 256 }).notNull(), // provider name or "Demo data"
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
  isDemo: boolean("is_demo").default(true).notNull(),
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
