import { z } from "zod";

// ─── Common ─────────────────────────────────────────────────────────────────

export const uuidSchema = z.string().uuid();
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const locationReferenceRequestSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
}).strict();

const locationReferenceBaseSchema = z.object({
  source: z.literal("Natural Earth + GeoNames"),
  datasetVersion: z.string().min(1),
  checkedAt: z.string().datetime(),
  isTravelFact: z.literal(false),
});

export const locationReferenceResponseSchema = z.discriminatedUnion("outcome", [
  locationReferenceBaseSchema.extend({
    outcome: z.literal("REFERENCE"),
    country: z.string().min(1),
    countryCode: z.string().length(2).nullable(),
    admin1: z.string().min(1).nullable(),
    admin1Code: z.string().min(1).nullable(),
    nearestCity: z.string().min(1).nullable(),
    nearestCityCoordinates: z.object({
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
    }).strict().nullable(),
    introductionSourceId: z.string().min(1).max(128).nullable().optional(),
    distanceKm: z.number().nonnegative().nullable(),
  }),
  locationReferenceBaseSchema.extend({ outcome: z.literal("NO_REFERENCE") }),
]);

// ─── Location Introduction (anonymous, shared cache) ─────────────────────────
// S4 / docs/location-introduction-cache-implementation.md §6. Accepts only
// `{ sourceId, locale }` — never coordinates, never user/Trip data. The
// response is either READY (200) or GENERATING (202); failures surface as
// `LOCATION_INTRODUCTION_*` codes via `errorResponseSchema`.

export const locationIntroductionLocaleSchema = z.enum(["en", "zh"]);

export const locationIntroductionRequestSchema = z.object({
  sourceId: z.string().min(1).max(128),
  locale: locationIntroductionLocaleSchema,
}).strict();

export const locationIntroductionReadySchema = z.object({
  status: z.literal("READY"),
  content: z.string().min(1).max(720),
  cacheStatus: z.enum(["HIT", "MISS"]),
  expiresAt: z.string().datetime(),
}).strict();

export const locationIntroductionGeneratingSchema = z.object({
  status: z.literal("GENERATING"),
  retryAfterMs: z.number().int().positive().max(60_000),
}).strict();

export const locationIntroductionResponseSchema = z.union([
  locationIntroductionReadySchema,
  locationIntroductionGeneratingSchema,
]);

// ─── Profile ────────────────────────────────────────────────────────────────

export const createProfileSchema = z.object({
  nationality: z.string().max(64).optional(),
  dateOfBirth: dateStr.optional(),
  interests: z.array(z.string()).optional(),
  accommodationStyle: z.enum(["city_center", "budget", "luxury"]).optional(),
  budgetMaxUsd: z.number().int().positive().optional(),
  noRedEye: z.boolean().optional(),
  mobilityNotes: z.string().optional(),
  availableDepartureDates: z.array(dateStr).optional(),
  departureCity: z.string().max(64).optional(),
}).strict();

export const updateProfileSchema = createProfileSchema.partial();

export const profileSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  displayName: z.string(),
  nationality: z.string().nullable(),
  dateOfBirth: dateStr.nullable(),
  interests: z.array(z.string()).nullable(),
  accommodationStyle: z.enum(["city_center", "budget", "luxury"]).nullable(),
  budgetMaxUsd: z.number().int().positive().nullable(),
  noRedEye: z.boolean().nullable(),
  mobilityNotes: z.string().nullable(),
  availableDepartureDates: z.array(dateStr).nullable(),
  departureCity: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const profileResponseSchema = z.object({
  profile: profileSchema.nullable(),
});

export const updateProfileResponseSchema = z.object({
  message: z.literal("Profile updated"),
  profile: profileSchema,
});

// ─── Trip ───────────────────────────────────────────────────────────────────

export const createTripSchema = z.object({
  name: z.string().min(1).max(256),
  departureCities: z.array(z.string().min(1)).min(1),
  // A newly created Draft has one required member, so it may start with a
  // single SOLO candidate. TEAM bounds are enforced at activation.
  destinationCandidates: z.array(z.string().min(1)).min(1).max(5),
  travelDateStart: dateStr.optional(),
  travelDateEnd: dateStr.optional(),
}).strict();

export const tripStatusSchema = z.enum(["DRAFT", "PLANNING", "CONFIRMED", "BOOKED", "CANCELLED", "STALE"]);
export const tripArchiveReasonSchema = z.enum(["USER_ARCHIVED", "DATE_ELAPSED"]);
export const tripRoleSchema = z.enum(["CREATOR", "MEMBER"]);

export const projectDisplayStateSchema = z.enum([
  "DRAFT",
  "ACTION_REQUIRED",
  "IN_PROGRESS",
  "COMPLETED",
  "ARCHIVED",
  "CANCELLED",
]);

export const latestPlanStatusSchema = z.enum(["DRAFT", "ACTIVE", "STALE", "SUPERSEDED"]);

export const nextActionTypeSchema = z.enum([
  "EDIT_DRAFT",
  "REVIEW_PLAN",
  "GRANT_CONSENT",
  "CHECK_READINESS",
  "CONFIRM_PLAN",
  "VIEW_PROJECT",
  "VIEW_HISTORY",
]);

export const latestPlanSchema = z.object({
  id: uuidSchema,
  version: z.number().int().nonnegative(),
  status: latestPlanStatusSchema,
  generatedAt: z.string().datetime(),
});

export const nextActionSchema = z.object({
  type: nextActionTypeSchema,
  label: z.string().min(1).max(128),
  href: z.string().min(1).max(512),
});

/**
 * Server-managed projection of the latest owner-accepted terminal run for
 * a Trip. Surfaced on `tripSummarySchema` and `tripDetailsResponseSchema`
 * so the trip header / chat can render a single "current result" card
 * without the owner having to scroll through every agent run.
 *
 * The pointer is server-managed: writes happen in
 * `pinSessionIfAbsent` (confirmAndSearch tx) and `pinSessionIfTerminal`
 * (runResearch terminal events). No manual pin/unpin UI in MVP.
 */
export const tripPinnedSessionSchema = z.object({
  agentTaskRunId: uuidSchema,
  operation: z.enum(["CONVERSATION", "PLAN", "REPLAN", "RESEARCH"]),
  status: z.enum([
    "QUEUED", "RUNNING", "CANCEL_REQUESTED", "COMPLETED", "COMPLETED_WITH_GAPS",
    "FAILED", "CANCELLED", "STALE",
  ]),
  destinationCandidates: z.array(z.string()).max(5),
  travelDays: z.number().int().min(1).max(365).nullable(),
  generatedAt: z.string().datetime(),
  pinnedAt: z.string().datetime(),
}).strict();

export const tripSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  status: tripStatusSchema,
  departureCities: z.array(z.string()),
  destinationCandidates: z.array(z.string()),
  travelDateStart: dateStr.nullable(),
  travelDateEnd: dateStr.nullable(),
  archivedAt: z.string().datetime().nullable(),
  archiveReason: tripArchiveReasonSchema.nullable(),
  memberCount: z.number().int().nonnegative(),
  role: tripRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  displayState: projectDisplayStateSchema,
  latestPlan: latestPlanSchema.nullable(),
  nextAction: nextActionSchema.nullable(),
  // Quick orchestration — server-managed pointer to the latest
  // owner-accepted terminal run. Null when no run has been pinned yet.
  // `.optional()` so legacy responses that predate the column still parse
  // cleanly; new responses always include the field (server projects it
  // from `shared_trips.pinned_session_id`).
  pinnedSession: tripPinnedSessionSchema.nullable().optional(),
});

export const tripsResponseSchema = z.object({
  trips: z.array(tripSummarySchema),
  nextCursor: z.string().nullable().optional(),
});

export const tripMemberSchema = z.object({
  userId: uuidSchema,
  displayName: z.string(),
  role: tripRoleSchema,
  isRequired: z.boolean(),
  joinedAt: z.string().datetime(),
});

export const tripDetailsResponseSchema = z.object({
  trip: z.object({
    id: uuidSchema,
    name: z.string(),
    createdBy: uuidSchema,
    status: tripStatusSchema,
    departureCities: z.array(z.string()),
    destinationCandidates: z.array(z.string()),
    travelDateStart: dateStr.nullable(),
    travelDateEnd: dateStr.nullable(),
    travelDays: z.number().int().nullable(),
    archivedAt: z.string().datetime().nullable(),
    archiveReason: tripArchiveReasonSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    pinnedSession: tripPinnedSessionSchema.nullable().optional(),
  }),
  callerRole: tripRoleSchema,
  members: z.array(tripMemberSchema),
});

export const joinTripSchema = z.object({
  tripId: uuidSchema,
});

// ─── Consent ────────────────────────────────────────────────────────────────

export const consentScopeValues = [
  "PROFILE_BASIC",
  "PROFILE_PREFERENCES",
  "PROFILE_NATIONALITY",
  "PROFILE_DOCUMENTS",
  "PROFILE_BUDGET",
  "PROFILE_RESTRICTIONS",
] as const;

export const grantConsentSchema = z.object({
  tripId: uuidSchema,
  scope: z.enum(consentScopeValues),
  fieldList: z.array(z.string().min(1)).min(1),
});

export const revokeConsentSchema = z.object({
  tripId: uuidSchema,
  scope: z.enum(consentScopeValues),
});

// ─── Planning ───────────────────────────────────────────────────────────────

export const planRequestSchema = z.object({
  tripId: uuidSchema,
});

export const flightCabinSchema = z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]);
export const tripSearchPreferencesRequestSchema = z.object({
  tripType: z.enum(["ONE_WAY", "ROUND_TRIP"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  adults: z.number().int().min(1).max(9),
  cabin: flightCabinSchema,
  offerFreshnessMinutes: z.number().int().min(1).max(1_440),
}).strict();

export const tripSearchPreferencesResponseSchema = z.object({
  tripId: uuidSchema,
  version: z.number().int().positive(),
  tripType: z.enum(["ONE_WAY", "ROUND_TRIP"]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  adults: z.number().int().min(1).max(9),
  cabin: flightCabinSchema,
  offerFreshnessMinutes: z.number().int().min(1).max(1_440),
  confirmedBy: uuidSchema,
  createdAt: z.string().datetime(),
});

export const tripStaySearchPreferencesRequestSchema = z.object({
  roomCount: z.number().int().min(1).max(8),
  adultsPerRoom: z.array(z.number().int().min(1).max(8)).min(1).max(8),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict().superRefine((value, ctx) => {
  if (value.adultsPerRoom.length !== value.roomCount) {
    ctx.addIssue({ code: "custom", message: "adultsPerRoom must contain one entry per room", path: ["adultsPerRoom"] });
  }
});

export const tripStaySearchPreferencesResponseSchema = z.object({
  tripId: uuidSchema,
  version: z.number().int().positive(),
  roomCount: z.number().int().min(1).max(8),
  adultsPerRoom: z.array(z.number().int().min(1).max(8)).min(1).max(8),
  currency: z.string().regex(/^[A-Z]{3}$/),
  priceDisplayMode: z.literal("TOTAL_AND_PER_NIGHT"),
  taxFeeDisclosure: z.literal("SHOW_POSSIBLY_EXTRA_WHEN_UNKNOWN"),
  confirmedBy: uuidSchema,
  createdAt: z.string().datetime(),
});

export const changeEventSchema = z.object({
  tripId: uuidSchema,
  eventId: uuidSchema,
  eventType: z.enum(["PRICE_CHANGE", "INVENTORY_CHANGE", "DEPARTURE_RESTRICTION"]),
  payload: z.record(z.string(), z.unknown()),
});

// ─── Confirmation ───────────────────────────────────────────────────────────

export const confirmPlanSchema = z.object({
  planId: uuidSchema,
  tripId: uuidSchema,
  decision: z.enum(["CONFIRMED", "NEEDS_CHANGES"]),
});

// ─── Chat Threads (owner-only private conversation) ────────────────────────

export const chatThreadScopeSchema = z.enum(["TRIP"]);
export type ChatThreadScope = z.infer<typeof chatThreadScopeSchema>;

// Deprecated: the optional `tripId` field has been removed; thread
// creation is now Trip-scoped only.  Kept exported for any in-flight
// migration tooling, but no route accepts it any more.
export const createThreadSchema = z.object({
  title: z.string().min(1).max(256),
  tripId: uuidSchema.optional(),
}).strict();

export const createTripThreadSchema = z.object({
  title: z.string().trim().min(1).max(256),
}).strict();

export const threadSummarySchema = z.object({
  id: uuidSchema,
  ownerUserId: uuidSchema,
  tripId: uuidSchema,
  scope: chatThreadScopeSchema,
  isDefault: z.boolean(),
  title: z.string(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

export const threadsListResponseSchema = z.object({
  threads: z.array(threadSummarySchema),
});

export const chatMessageRoleSchema = z.enum(["USER", "ASSISTANT"]);

// Legacy one-way append remains owner-only and can create USER messages only.
// The browser never chooses a persisted role or sender identity.
export const appendMessageSchema = z.object({
  body: z.string().min(1).max(16384),
  markedSharedByOwner: z.boolean().optional(),
}).strict();

export const chatMessageRedactedSchema = z.object({
  id: uuidSchema,
  role: z.string(),
  contentRedacted: z.string(),
  createdAt: z.string().datetime(),
});

export const threadMessagesResponseSchema = z.object({
  messages: z.array(chatMessageRedactedSchema),
});

export const threadDetailsResponseSchema = z.object({
  thread: threadSummarySchema,
  messages: z.array(chatMessageRedactedSchema),
});

export const conversationPlaceSchema = z.object({
  sourceId: z.string().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(160),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  sourceType: z.enum(["REFERENCE", "INSPIRATION"]),
}).strict();

export const conversationIntentSchema = z.enum(["auto_intro", "user_typed"]);

export const conversationTurnRequestSchema = z.object({
  requestId: uuidSchema,
  question: z.string().trim().min(1).max(4000),
  place: conversationPlaceSchema.optional(),
  intent: conversationIntentSchema.optional(),
}).strict();

export const ownerConversationMessageSchema = z.object({
  id: uuidSchema,
  role: chatMessageRoleSchema,
  content: z.string(),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export const conversationResponseModeSchema = z.enum(["MODEL", "SAFE_REFUSAL", "FALLBACK"]);

export const agentTaskOperationSchema = z.enum(["CONVERSATION", "PLAN", "REPLAN", "RESEARCH", "PERSONAL_RESEARCH"]);
export const agentTaskStatusSchema = z.enum([
  "QUEUED", "RUNNING", "CANCEL_REQUESTED", "COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED", "STALE",
]);
export const agentRunPhaseSchema = z.enum([
  "ACCEPTED", "RESEARCHING", "GENERATING", "VALIDATING", "PERSISTING",
  "RETRYING", "COMPLETED", "STALE", "FAILED",
]);
export const agentRunErrorCodeSchema = z.enum([
  "NETWORK", "UPSTREAM_5XX", "UPSTREAM_FAILURE", "TIMEOUT", "SCHEMA_PARSE",
  "TOOL_PROTOCOL",
  "POLICY_DENIED", "SEARCH_PREFERENCES_STALE", "PLANNING_DATA_UNAVAILABLE",
  "UNKNOWN_SKILL", "TOOL_CALL_MAX_TURNS", "CANCELLED", "EXPIRED", "RETRY_EXHAUSTED", "INTERNAL",
]);

export const conversationTurnAcceptedResponseSchema = z.object({
  threadId: uuidSchema,
  runId: uuidSchema,
  operation: z.literal("CONVERSATION"),
  status: z.literal("QUEUED"),
  generationAttempt: z.literal(0),
  userMessage: ownerConversationMessageSchema.extend({ role: z.literal("USER") }),
});

export const ownerConversationResponseSchema = z.object({
  thread: threadSummarySchema,
  messages: z.array(ownerConversationMessageSchema),
});

export const agentRunResponseSchema = z.object({
  runId: uuidSchema,
  operation: agentTaskOperationSchema,
  status: agentTaskStatusSchema,
  generationAttempt: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  errorCode: agentRunErrorCodeSchema.nullable(),
  assistantMessageId: uuidSchema.nullable(),
  resultPlanId: uuidSchema.nullable(),
  /**
   * Personal Research Intent Routing — Phase 0/1.
   * Owner-safe DTO for the persisted research-intent draft. Surfaced only
   * when a CONVERSATION run carries a non-null draft (and only to the
   * owning user). Plan/REPLAN/Research runs keep these null. Inline
   * literals here (mirroring the canonical `personalResearch*Schema`
   * declared below) because `agentRunResponseSchema` is referenced from
   * callers above this section. See
   * docs/personal-research-intent-routing-implementation.md §4.2.
   */
  researchIntentDraft: z.object({
    kind: z.enum(["RESEARCH_ONLY", "PROPOSE_PLAN"]),
    requestedCapabilities: z.array(z.enum([
      "flight", "accommodation", "hotel", "activities", "places", "navigation", "mobility", "readiness",
    ])).min(1),
    readiness: z.enum(["READY", "READY_WITH_WARNINGS", "NEEDS_SETUP", "NEEDS_PLACE_SELECTION"]),
    blockers: z.array(z.enum([
      "TRIP_NOT_ACTIVE",
      "DESTINATION_NOT_CONFIGURED",
      "DATES_MISSING",
      "FLIGHT_PREFERENCES_MISSING",
      "STAY_PREFERENCES_MISSING",
      "HOTEL_PROVIDER_NOT_APPROVED",
      "QUOTE_NATIONALITY_AUTHORIZATION_MISSING",
      "ROUTE_ENDPOINTS_UNCONFIRMED",
      "MODE_NOT_CHOSEN",
      "BUDGET_HINT_MISSING",
    ])).default([]),
    warnings: z.array(z.enum([
      "TRIP_NOT_ACTIVE",
      "DESTINATION_NOT_CONFIGURED",
      "DATES_MISSING",
      "FLIGHT_PREFERENCES_MISSING",
      "STAY_PREFERENCES_MISSING",
      "HOTEL_PROVIDER_NOT_APPROVED",
      "QUOTE_NATIONALITY_AUTHORIZATION_MISSING",
      "ROUTE_ENDPOINTS_UNCONFIRMED",
      "MODE_NOT_CHOSEN",
      "BUDGET_HINT_MISSING",
    ])).default([]),
    missing: z.array(z.enum([
      "TRIP_NOT_ACTIVE",
      "DESTINATION_NOT_CONFIGURED",
      "DATES_MISSING",
      "FLIGHT_PREFERENCES_MISSING",
      "STAY_PREFERENCES_MISSING",
      "HOTEL_PROVIDER_NOT_APPROVED",
      "QUOTE_NATIONALITY_AUTHORIZATION_MISSING",
      "ROUTE_ENDPOINTS_UNCONFIRMED",
      "MODE_NOT_CHOSEN",
      "BUDGET_HINT_MISSING",
    ])),
  }).strict().nullable(),
  researchIntentState: z.enum(["PROPOSED", "DISMISSED", "CONFIRMED", "SUPERSEDED"]).nullable(),
  // researchSetupSession was removed with the conversational setup pipeline
  // (migration 0049). State now lives in chat history + personal_research_evidence.
  /**
   * Whether this thread has a `flight.search` draft the owner has not yet
   * confirmed. Only `getAuthorizedAgentRun` computes this (other builders of
   * this DTO — planning-run reads, the cancel route's early return — leave
   * it absent, which the client treats as false); it exists so the chat
   * UI's confirm/cancel button survives a dropped or reconnected SSE stream
   * by re-deriving from this already-polled resource instead of relying
   * solely on the one-shot `tool.settled` event.
   */
  pendingFlightConfirmation: z.boolean().optional(),
});

const streamBaseSchema = z.object({
  runId: uuidSchema,
  generationAttempt: z.number().int().nonnegative(),
  /**
   * Optional W3C `traceparent` header value forwarded from the originating
   * HTTP request. Carried by every NOTIFY payload so the relay can re-enter
   * the originating trace context for SSE events. PII / credentials are
   * never embedded here — only OTel identifiers.
   */
  traceparent: z
    .string()
    .regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}(-[a-z0-9_,=+/-]{1,256})?$/i)
    .optional(),
});

// ─── Personal Trip Research ─────────────────────────────────────────────────
// Phase 1 — Personal Trip Orchestrator. Zod schemas for the
// `personalResearchIntent`, the closed-shape research command request/response,
// the dedicated 8-stage research SSE channel, and the
// `research.intent_extracted` SSE event. `.strict()` rejects every extra
// field at the API boundary; the server derives every authority field from
// the active Trip / required-member state.
// Source of truth: docs/personal-trip-orchestration-implementation.md §4,
// docs/contracts/research-command.md.

export const personalResearchCapabilitySchema = z.enum([
  "flight",
  "accommodation",
  "hotel",
  "activities",
  "places",
  "navigation",
  "mobility",
  "readiness",
]);

export const personalResearchKindSchema = z.enum([
  "RESEARCH_ONLY",
  "PROPOSE_PLAN",
]);

export const personalResearchIntentSchema = z.object({
  kind: personalResearchKindSchema,
  requestedCapabilities: z.array(personalResearchCapabilitySchema).min(1),
  destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(1).max(5).optional(),
}).strict();

/**
 * Personal Research Intent Routing — Phase 0/1.
 * Lifecycle of the persisted draft. SUPERSEDED is server-internal and is
 * NEVER exposed via owner DTOs. Source:
 * docs/personal-research-intent-routing-implementation.md §4.1.
 */
export const researchIntentStateSchema = z.enum([
  "PROPOSED",
  "DISMISSED",
  "CONFIRMED",
  "SUPERSEDED",
]);

/** Readiness outcome evaluated by `personal-research-readiness-service`.
 *  `READY_WITH_WARNINGS` means no hard blockers but at least one soft warning
 *  — the owner is allowed to proceed past it via the real-provider
 *  confirmation modal in the web client. Source:
 *  docs/personal-research-intent-routing-implementation.md §5.2. */
export const researchReadinessSchema = z.enum([
  "READY",
  "READY_WITH_WARNINGS",
  "NEEDS_SETUP",
  "NEEDS_PLACE_SELECTION",
]);

/** Stable gap codes emitted in `missing[]`. Web renders via lookup table. */
export const researchMissingCodeSchema = z.enum([
  "TRIP_NOT_ACTIVE",
  "DESTINATION_NOT_CONFIGURED",
  "DATES_MISSING",
  "FLIGHT_PREFERENCES_MISSING",
  "STAY_PREFERENCES_MISSING",
  "HOTEL_PROVIDER_NOT_APPROVED",
  "QUOTE_NATIONALITY_AUTHORIZATION_MISSING",
  "ROUTE_ENDPOINTS_UNCONFIRMED",
  "MODE_NOT_CHOSEN",
  "BUDGET_HINT_MISSING",
]);

/**
 * Persisted, non-executable research-intent draft. `.strict()` rejects every
 * extra field — including coordinates, dates, party size, currency, provider,
 * place IDs, identity, and the original question text. The MVP deliberately
 * does NOT consume `destinationCandidates` (spec §4.1).
 *
 * `blockers` and `warnings` are optional for backward compatibility with
 * drafts persisted before the Phase 2 two-tier split — old rows have
 * `null` and the projection default-fills both to `[]`. `missing[]` is
 * retained as the union of the two for older clients.
 */
export const persistedResearchIntentDraftSchema = z.object({
  schemaVersion: z.literal(1),
  kind: personalResearchKindSchema,
  requestedCapabilities: z.array(personalResearchCapabilitySchema).min(1),
  classifierVersion: z.string().min(1).max(64),
  readiness: researchReadinessSchema,
  blockers: z.array(researchMissingCodeSchema).default([]),
  warnings: z.array(researchMissingCodeSchema).default([]),
  missing: z.array(researchMissingCodeSchema),
}).strict();

/**
 * Closed-shape request for `POST /api/v1/trips/:tripId/research`.
 * `.strict()` rejects any extra field — including `snapshotId`, `provider`,
 * `latitude`, `longitude`, `placeId`, `dates`, `currency`, `toolCallId`,
 * `identity`, or chat content. The server derives every authority field
 * from the active Trip / required-member state.
 */
export const researchCommandRequestSchema = z.object({
  requestId: uuidSchema,
  outputMode: personalResearchKindSchema,
  requestedCapabilities: z.array(personalResearchCapabilitySchema).min(1),
  // Present only when an owner confirms a persisted Personal conversation
  // draft. It binds acceptance to that exact PROPOSED run; it is never a
  // substitute for the server-side ownership/readiness checks.
  originatingIntentRunId: uuidSchema.optional(),
}).strict();

/** 202 envelope for an accepted research command. */
export const researchCommandAcceptedResponseSchema = z.object({
  runId: uuidSchema,
  operation: z.enum(["RESEARCH", "PLAN"]),
  snapshotId: uuidSchema,
  status: z.literal("QUEUED"),
}).strict();

/**
 * Safe research-stage enum used by the dedicated `research.stage` SSE
 * channel. Kept separate from `agentRunPhaseSchema` so cross-cutting phases
 * (ACCEPTED / GENERATING / RETRYING / etc.) stay orthogonal to the
 * research lifecycle.
 */
export const researchStageSchema = z.enum([
  "SNAPSHOT_CREATED",
  "RESEARCHING",
  "VALIDATING",
  "PERSISTING",
  "COMPLETED",
  "COMPLETED_WITH_GAPS",
  "FAILED",
  "STALE",
]);

/** `research.stage` SSE event. */
export const researchStageEventSchema = streamBaseSchema.extend({
  event: z.literal("research.stage"),
  stage: researchStageSchema,
}).strict();

/**
 * `research.intent_extracted` SSE event — carries the classifier-extracted
 * research draft. The intent field is the closed-shape
 * `personalResearchIntent`; `readiness` + `missing` describe the server-side
 * evaluation outcome. The event NEVER includes the question text, free-text
 * place names, profile values, snapshot payloads, or provider raw responses.
 * Source: docs/personal-research-intent-routing-implementation.md §4.2.
 */
export const researchIntentExtractedEventSchema = streamBaseSchema.extend({
  event: z.literal("research.intent_extracted"),
  intent: personalResearchIntentSchema,
  readiness: researchReadinessSchema,
  blockers: z.array(researchMissingCodeSchema).default([]),
  warnings: z.array(researchMissingCodeSchema).default([]),
  missing: z.array(researchMissingCodeSchema),
  schemaVersion: z.literal(1),
  classifierVersion: z.string().min(1).max(64),
}).strict();

/**
 * `research.intent_dismissed` SSE event — emitted when the owner dismisses
 * a PROPOSED draft via `POST /agent-runs/:runId/dismiss-intent`. Carries no
 * draft content (the draft is preserved in DB but hidden from owner DTOs).
 */
export const researchIntentDismissedEventSchema = streamBaseSchema.extend({
  event: z.literal("research.intent_dismissed"),
  dismissedAt: z.string().datetime(),
}).strict();

// ─── Personal Research Setup Sessions (docs §9) ────────────────────────────

// Conversational setup card schemas (conversationalSetupMissingCodeSchema,
// personalResearchSetupAnswerSchema, personalResearchSetupApplyRequestSchema,
// personalResearchSetupSessionStatusSchema, personalResearchSetupSessionResponseSchema,
// personalResearchSetupSessionEnvelopeSchema, personalResearchSetupConfirmRequestSchema,
// personalResearchSetupConfirmAcceptedResponseSchema) were removed with
// the conversational setup pipeline (migration 0049). State now lives in
// chat history + personal_research_evidence.

/**
 * ─── DRAFT Personal Research (docs/draft-personal-research-implementation.md) ──
 *
 * Owner-only typed draft + request/response shapes. The state machine
 * `DRAFT → CONFIRMED → QUEUED → COMPLETED | COMPLETED_WITH_GAPS | FAILED |
 * CANCELLED` lives across two rows: the CONVERSATION row carries the typed
 * draft + readiness during DRAFT/CONFIRMED; the PERSONAL_RESEARCH durable
 * row carries QUEUED/COMPLETED/etc.
 *
 * The runtime allow-list (apps/api/src/config/personal-research-allowed-capabilities.ts)
 * gates which `capability` values the owner may confirm. Confirming a draft
 * whose `kind` is not in the allow-list returns 422 — the Zod discriminated
 * union accepts all 7 shapes here for forward-compatibility, and the route
 * applies the gate.
 */
export const personalResearchOperationCapabilitySchema = z.enum([
  "flight.search",
  "hotel.search",
  "accommodation.discovery",
  "activities.search",
  "places.search",
  "navigation.route",
  "mobility.search",
]);
export type PersonalResearchOperationCapability = z.infer<typeof personalResearchOperationCapabilitySchema>;

const iataCodeSchema = z.string().regex(/^[A-Z]{3}$/);
/**
 * A city the location resolver can look up — an IATA city code (`TYO`) or a
 * city name (`Kyoto`, `京都`), which is what it already accepts.
 *
 * Requiring bare IATA here silently broke every city the model named in
 * words. The hotel tool's own description invites "IATA city code or city
 * name", so a call saying `Kyoto` was well-formed by the contract the model
 * was given, failed this schema, and came back as an unreported NEEDS_FIELDS
 * — the traveller just saw a search that never finished. Cities whose code
 * the model happened to know (`SHA`, `TYO`) worked, which is why it looked
 * intermittent.
 */
const cityReferenceSchema = z.string().trim().min(2).max(64);
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);

export const personalResearchFlightDraftSchema = z.object({
  kind: z.literal("FLIGHT_SEARCH"),
  originId: iataCodeSchema,
  destinationId: iataCodeSchema,
  tripType: z.enum(["ONE_WAY", "ROUND_TRIP"]),
  departureDate: dateOnlySchema,
  returnDate: dateOnlySchema.nullable(),
  adults: z.number().int().min(1).max(9),
  cabin: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]),
  currency: currencyCodeSchema,
}).strict().superRefine((draft, ctx) => {
  if (draft.tripType === "ROUND_TRIP" && draft.returnDate === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["returnDate"], message: "round-trip requires returnDate" });
  }
  if (draft.returnDate !== null && draft.returnDate < draft.departureDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["returnDate"], message: "returnDate must be on or after departureDate" });
  }
});

export const personalResearchHotelDraftSchema = z.object({
  kind: z.literal("HOTEL_SEARCH"),
  cityCode: cityReferenceSchema,
  checkIn: dateOnlySchema,
  checkOut: dateOnlySchema,
  occupancy: z.object({
    adults: z.number().int().min(1).max(8),
    rooms: z.number().int().min(1).max(8),
  }).strict(),
  currency: currencyCodeSchema,
}).strict().superRefine((draft, ctx) => {
  if (draft.checkOut <= draft.checkIn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checkOut"], message: "checkOut must be after checkIn" });
  }
});

const personalResearchAccommodationDraftSchema = z.object({
  kind: z.literal("ACCOMMODATION_DISCOVERY"),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(100).max(50_000),
  checkIn: dateOnlySchema,
  checkOut: dateOnlySchema,
  occupancy: z.object({
    adults: z.number().int().min(1).max(8),
    rooms: z.number().int().min(1).max(8),
  }).strict(),
}).strict();

const personalResearchActivitiesDraftSchema = z.object({
  kind: z.literal("ACTIVITIES_SEARCH"),
  destinationCode: z.string().trim().min(1).max(64),
  startDate: dateOnlySchema,
  endDate: dateOnlySchema,
  category: z.string().trim().min(1).max(64).nullable(),
  limit: z.number().int().min(1).max(50).nullable(),
}).strict().superRefine((draft, ctx) => {
  if (draft.endDate < draft.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "endDate must be on or after startDate" });
  }
});

const personalResearchPlacesDraftSchema = z.object({
  kind: z.literal("PLACES_SEARCH"),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(100).max(50_000),
  category: z.enum(["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"]).nullable(),
  /**
   * What the traveller asked for in their own words — "ramen", "onsen",
   * "書店". Null when they only asked what is nearby.
   *
   * Without this the draft could express "restaurants near here" but not
   * "ramen near here", so the executor filled the gap by searching for the
   * category name itself, which is a kind and not a name and matched almost
   * nothing real.
   */
  keyword: z.string().trim().min(1).max(64).nullable(),
  limit: z.number().int().min(1).max(50).nullable(),
}).strict();

/**
 * A route endpoint given as a point on the map, with the name the traveller
 * used for it.
 *
 * The label is carried so the answer can say what it is a route between.
 * "3.4 km, 42 minutes" is not an answer to "从京都站到清水寺要多久" unless it
 * says which two places it measured.
 */
const routeEndpointSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  label: z.string().trim().min(1).max(80),
}).strict();

/**
 * Two ways to name the ends of a route, and a route needs exactly one of them.
 *
 * Trip-place ids are what the plan uses, and they stay: adopting a route
 * between two places already in the itinerary is the durable operation this
 * capability was built for. But nothing in a conversation carries those ids —
 * the whole database holds two trip-place rows — so a traveller asking "从京都
 * 站到清水寺怎么走" could not be answered at all, and the capability was left
 * out of the model's tools entirely because it could only ever fail.
 * Coordinates are the form a conversation can actually supply.
 */
const personalResearchNavigationRouteDraftSchema = z.object({
  kind: z.literal("NAVIGATION_ROUTE"),
  originPlaceId: z.string().uuid().nullable().default(null),
  destinationPlaceId: z.string().uuid().nullable().default(null),
  origin: routeEndpointSchema.nullable().default(null),
  destination: routeEndpointSchema.nullable().default(null),
  mode: z.enum(["driving", "walking", "cycling"]),
}).strict().superRefine((draft, ctx) => {
  const byId = draft.originPlaceId !== null && draft.destinationPlaceId !== null;
  const byPoint = draft.origin !== null && draft.destination !== null;
  if (byId === byPoint) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["origin"],
      message: "give either both place ids or both coordinates, not a mixture and not neither",
    });
  }
  if (byId && draft.originPlaceId === draft.destinationPlaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationPlaceId"], message: "origin and destination must differ" });
  }
  if (byPoint && draft.origin!.latitude === draft.destination!.latitude
    && draft.origin!.longitude === draft.destination!.longitude) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destination"], message: "origin and destination must differ" });
  }
});

const personalResearchMobilityDraftSchema = z.object({
  kind: z.literal("MOBILITY_SEARCH"),
  originPlaceId: z.string().uuid(),
  destinationPlaceId: z.string().uuid(),
  transferDateTime: z.string().datetime(),
  passengers: z.number().int().min(1).max(8),
  currency: currencyCodeSchema,
}).strict().superRefine((draft, ctx) => {
  if (draft.originPlaceId === draft.destinationPlaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationPlaceId"], message: "origin and destination must differ" });
  }
});

export const personalResearchOwnerDraftSchema = z.discriminatedUnion("kind", [
  personalResearchFlightDraftSchema,
  personalResearchHotelDraftSchema,
  personalResearchAccommodationDraftSchema,
  personalResearchActivitiesDraftSchema,
  personalResearchPlacesDraftSchema,
  personalResearchNavigationRouteDraftSchema,
  personalResearchMobilityDraftSchema,
]);
export type PersonalResearchOwnerDraft = z.infer<typeof personalResearchOwnerDraftSchema>;

export const personalResearchAnswersRequestSchema = z.object({
  schemaVersion: z.literal(1),
  draft: personalResearchOwnerDraftSchema,
}).strict();

export const personalResearchConfirmRequestSchema = z.object({
  requestId: uuidSchema,
}).strict();

export const personalResearchOutcomeSchema = z.enum(["AVAILABLE", "UNAVAILABLE", "EXPIRED"]);

/**
 * Per-capability result summaries. Each shape is the BOUNDED projection
 * shown in `GET /agent-runs/:runId/personal-research` — never raw provider
 * payloads, chat text, nationality, passport, or document data. Spec §3.2.
 */
/**
 * One thing a research tool actually found.
 *
 * Summaries used to carry counts and a price band and nothing else, which
 * left the model with "there are five restaurants nearby" — not enough to
 * answer with, so it answered from its own knowledge instead and the lookup
 * counted for nothing.
 *
 * Isolation from Shared planning is not what this was protecting: personal
 * evidence is already scoped by owner, trip and run, and Shared plans read a
 * different table under snapshot binding. Emptying the payload defended
 * something already defended.
 *
 * Still bounded: a handful of items, no supplier tokens, no booking URLs, no
 * raw provider payload. `capturedAt` travels with them because a price is
 * only true as of a moment.
 */
export const personalResearchEvidenceItemSchema = z.object({
  /** Property, place, activity title, or a flight's route summary. */
  label: z.string().trim().min(1).max(200),
  /** Null when the provider stated no denominated amount. */
  price: z.object({
    amount: z.number().nonnegative(),
    currency: currencyCodeSchema,
    /** What the amount is per, so a nightly rate is not read as a total. */
    unit: z.enum(["TOTAL", "PER_NIGHT", "PER_PERSON"]),
  }).strict().nullable(),
  /** Short qualifier: duration, board type, category, cabin. */
  detail: z.string().trim().max(160).nullable(),
}).strict();

export type PersonalResearchEvidenceItem = z.infer<typeof personalResearchEvidenceItemSchema>;

/** Ceiling per capability. Evidence is a prompt input, not a catalogue. */
export const PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT = 6;

// Bounded per-offer line items — richer and flight/hotel-specific, layered
// alongside the generic `items` above so the chat panel's structured result
// cards (FlightOfferCard / SearchHotelOfferCard) keep the per-field data
// (times, carrier, stop count) that a flat label/detail string can't carry.
// Capped at 5 and limited to the fields a normal search-results list would
// show — never a raw provider payload, booking link, or offer id.
export const personalResearchFlightOfferItemSchema = z.object({
  carrierCode: z.string(),
  flightNumber: z.string().nullable(),
  departureAt: z.string().datetime(),
  arrivalAt: z.string().datetime(),
  totalDuration: z.string(),
  totalPrice: z.number().nonnegative(),
  stopCount: z.number().int().nonnegative(),
}).strict();
export const personalResearchHotelOfferItemSchema = z.object({
  propertyName: z.string(),
  pricePerNight: z.number().nonnegative(),
  cancellationSummary: z.string().nullable(),
}).strict();

export const personalResearchFlightEvidenceSummarySchema = z.object({
  items: z.array(personalResearchEvidenceItemSchema).max(PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT).default([]),
  offerCount: z.number().int().nonnegative(),
  currency: currencyCodeSchema,
  originIata: iataCodeSchema,
  destinationIata: iataCodeSchema,
  earliestDeparture: z.string().datetime().nullable(),
  latestReturn: z.string().datetime().nullable(),
  topOffers: z.array(personalResearchFlightOfferItemSchema).max(5),
}).strict();
export const personalResearchHotelEvidenceSummarySchema = z.object({
  items: z.array(personalResearchEvidenceItemSchema).max(PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT).default([]),
  propertyCount: z.number().int().nonnegative(),
  currency: currencyCodeSchema,
  cityCode: cityReferenceSchema,
  checkIn: dateOnlySchema,
  checkOut: dateOnlySchema,
  minNightlyPrice: z.number().nonnegative().nullable(),
  maxNightlyPrice: z.number().nonnegative().nullable(),
  topOffers: z.array(personalResearchHotelOfferItemSchema).max(5),
}).strict();
export const personalResearchAccommodationEvidenceSummarySchema = z.object({
  items: z.array(personalResearchEvidenceItemSchema).max(PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT).default([]),
  candidateCount: z.number().int().nonnegative(),
  topCategory: z.string().nullable(),
  radiusMeters: z.number().int().nonnegative(),
  checkIn: dateOnlySchema,
  checkOut: dateOnlySchema,
}).strict();
export const personalResearchActivitiesEvidenceSummarySchema = z.object({
  items: z.array(personalResearchEvidenceItemSchema).max(PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT).default([]),
  activityCount: z.number().int().nonnegative(),
  currency: currencyCodeSchema.nullable(),
  destinationCode: z.string(),
  startDate: dateOnlySchema,
  endDate: dateOnlySchema,
  minPrice: z.number().nonnegative().nullable(),
  maxPrice: z.number().nonnegative().nullable(),
}).strict();
export const personalResearchPlacesEvidenceSummarySchema = z.object({
  items: z.array(personalResearchEvidenceItemSchema).max(PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT).default([]),
  candidateCount: z.number().int().nonnegative(),
  categories: z.array(z.string()),
  radiusMeters: z.number().int().nonnegative(),
}).strict();
export const personalResearchNavigationRouteEvidenceSummarySchema = z.object({
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
  mode: z.enum(["driving", "walking", "cycling"]),
  // What the route runs between. A distance with no ends is not an answer.
  origin: z.string().trim().max(80).nullable().default(null),
  destination: z.string().trim().max(80).nullable().default(null),
}).strict();
export const personalResearchMobilityEvidenceSummarySchema = z.object({
  offerCount: z.number().int().nonnegative(),
  currency: currencyCodeSchema.nullable(),
  transferDateTime: z.string().datetime(),
  passengers: z.number().int().nonnegative(),
}).strict();

export const personalResearchUnavailableEvidenceSummarySchema = z.object({
  errorCode: z.enum([
    "NOT_CONFIGURED",
    "SEARCH_CONSTRAINTS_INCOMPLETE",
    "NO_RESULTS",
    "RATE_LIMITED",
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_FAILURE",
    "INVALID_PROVIDER_RESPONSE",
    "PROVIDER_NOT_APPROVED",
  ]),
}).strict();

export const personalResearchEvidenceSummarySchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("AVAILABLE"),
    capability: personalResearchOperationCapabilitySchema,
    /**
     * Who answered, in the supplier's own name, and when.
     *
     * The reply is asked to say where a figure came from, and the summary
     * gave it nothing to say it with — so it cited the tool, telling the
     * traveller the prices came from "hotel.search". A citation has to name
     * something outside this system or it verifies nothing.
     *
     * Optional because an executor whose provider reports no source should
     * leave it absent rather than invent one.
     */
    supplier: z.string().trim().min(1).max(120).optional(),
    capturedAt: z.string().datetime().optional(),
    flight: personalResearchFlightEvidenceSummarySchema.optional(),
    hotel: personalResearchHotelEvidenceSummarySchema.optional(),
    accommodation: personalResearchAccommodationEvidenceSummarySchema.optional(),
    activities: personalResearchActivitiesEvidenceSummarySchema.optional(),
    places: personalResearchPlacesEvidenceSummarySchema.optional(),
    navigation: personalResearchNavigationRouteEvidenceSummarySchema.optional(),
    mobility: personalResearchMobilityEvidenceSummarySchema.optional(),
  }).strict(),
  z.object({
    outcome: z.literal("UNAVAILABLE"),
    summary: personalResearchUnavailableEvidenceSummarySchema,
  }).strict(),
  z.object({
    outcome: z.literal("EXPIRED"),
  }).strict(),
]);
export type PersonalResearchEvidenceSummary = z.infer<typeof personalResearchEvidenceSummarySchema>;

export const personalResearchEvidenceResponseSchema = z.object({
  id: uuidSchema,
  capability: personalResearchOperationCapabilitySchema,
  outcome: personalResearchOutcomeSchema,
  providerName: z.string(),
  source: z.string(),
  capturedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  summary: personalResearchEvidenceSummarySchema,
}).strict();

export const personalResearchReadResponseSchema = z.object({
  runId: uuidSchema,
  capability: personalResearchOperationCapabilitySchema,
  status: agentTaskStatusSchema,
  terminal: z.boolean(),
  draft: personalResearchOwnerDraftSchema.nullable(),
  evidence: personalResearchEvidenceResponseSchema.nullable(),
}).strict();
export type PersonalResearchReadResponse = z.infer<typeof personalResearchReadResponseSchema>;

export const personalResearchConfirmAcceptedResponseSchema = z.object({
  runId: uuidSchema,
  capability: personalResearchOperationCapabilitySchema,
  status: z.literal("QUEUED"),
}).strict();

// `setupFollowupQuestionSchema` and `setupFollowupEventSchema` were removed
// with the conversational setup pipeline (migration 0049). LLM-driven tool
// calling (Phase 4) replaces followup prompts with inline chat bubbles
// carried by `message.delta` events.

/**
 * Safe DTO returned by `GET /api/v1/trips/:tripId/research/latest`. Carries
 * only the persisted `planning_research_results` row + service-gap summary —
 * never raw provider payloads, snapshot values, or chat content.
 */
/**
 * Normalized provider evidence gathered by the run. Summaries only — the
 * raw `offer_data` payload never leaves the server (see the DTO note
 * above). Present so a caller can see *what* a research run actually
 * found; previously the run's offers were written and never readable.
 */
export const researchEvidenceOfferSchema = z.object({
  category: z.enum(["activity", "hotel"]),
  providerName: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  price: z.object({
    amount: z.number(),
    currency: z.string().length(3),
  }).strict().nullable(),
  rating: z.number().nullable(),
  detail: z.string().max(128).nullable(),
  capturedAt: z.string().datetime(),
}).strict();

export const researchResultResponseSchema = z.object({
  id: uuidSchema,
  tripId: uuidSchema,
  snapshotId: uuidSchema,
  agentTaskRunId: uuidSchema.nullable(),
  status: z.enum(["COMPLETE", "COMPLETED_WITH_GAPS"]),
  serviceGaps: z.array(z.record(z.string(), z.unknown())).max(64),
  resultPlanId: uuidSchema.nullable(),
  offers: z.array(researchEvidenceOfferSchema).max(32).default([]),
  createdAt: z.string().datetime(),
}).strict();

export const latestResearchResultResponseSchema = z.object({
  result: researchResultResponseSchema.nullable(),
}).strict();

/**
 * `tool.started` / `tool.settled` SSE events.
 *
 * A reply that pauses while a supplier answers reads as a hang. These say
 * the assistant went and looked something up, and how it went.
 *
 * Deliberately narrow: the capability, and for a settled call its outcome
 * plus a bounded reason code. No arguments, no provider payload, no counts.
 * Arguments would carry the user's own text back out over a channel meant
 * for status, and the findings already reach the browser in the reply.
 */
export const toolStartedEventSchema = streamBaseSchema.extend({
  event: z.literal("tool.started"),
  capability: personalResearchOperationCapabilitySchema,
}).strict();

export const toolSettledEventSchema = streamBaseSchema.extend({
  event: z.literal("tool.settled"),
  capability: personalResearchOperationCapabilitySchema,
  outcome: z.enum(["AVAILABLE", "UNAVAILABLE", "NEEDS_CONFIRMATION"]),
  reason: z.string().regex(/^[A-Z_]{3,40}$/).optional(),
  // Deliberate, narrow exception to the "no provider data on this channel"
  // rule: hotel.search/flight.search carry their own bounded top-offer list
  // (same shape and 5-item cap as the persisted evidence summary) so the
  // chat panel can render a structured result card instead of waiting for
  // the reply text to describe the same offers in prose.
  // Single currency for the whole search — every offer in one result set is
  // priced in the same requested currency, so this isn't denormalized onto
  // each item.
  currency: currencyCodeSchema.optional(),
  flightOffers: z.array(personalResearchFlightOfferItemSchema).max(5).optional(),
  hotelOffers: z.array(personalResearchHotelOfferItemSchema).max(5).optional(),
}).strict();

export const agentStreamEventSchema = z.discriminatedUnion("event", [
  toolStartedEventSchema,
  toolSettledEventSchema,
  streamBaseSchema.extend({
    event: z.literal("turn.started"),
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("run.phase"),
    phase: agentRunPhaseSchema,
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("message.delta"),
    sequence: z.number().int().nonnegative(),
    delta: z.string().min(1).max(2048),
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("turn.completed"),
    assistantMessageId: uuidSchema.optional(),
    resultPlanId: uuidSchema.optional(),
    responseMode: conversationResponseModeSchema.optional(),
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("trip.brief_proposed"),
    proposal: z.object({
      departureCities: z.array(z.string().trim().min(1).max(64)).min(1).max(3).optional(),
      destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(1).max(1).optional(),
      travelDateStart: dateStr.optional(),
      travelDays: z.number().int().min(1).max(365).optional(),
    }).strict(),
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("turn.cancelled"),
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("turn.stale"),
    code: agentRunErrorCodeSchema,
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("turn.failed"),
    code: agentRunErrorCodeSchema,
    retryable: z.boolean(),
  }).strict(),
  // Member conversation handoff (docs/member-conversation-handoff-implementation.md §5).
  // Fired when the conversation worker persisted a fresh candidate batch to
  // trip_constraint_proposals; the chat UI fetches and renders the card.
  streamBaseSchema.extend({
    event: z.literal("conversation.handoff_ready"),
    batchId: uuidSchema,
    candidateVersion: z.number().int().positive(),
    fieldKeys: z.array(z.string().min(1).max(64)).max(8),
  }).strict(),
  researchStageEventSchema,
  researchIntentExtractedEventSchema,
  researchIntentDismissedEventSchema,
]);

// ─── Booking ────────────────────────────────────────────────────────────────

export const bookingRequestSchema = z.object({
  planId: uuidSchema,
  tripId: uuidSchema,
  orchestrationRequestId: uuidSchema,
});

export const sandboxCallbackSchema = z.object({
  orchestrationRequestId: uuidSchema,
  eventId: uuidSchema,
  serviceResults: z.record(z.string(), z.object({
    status: z.enum(["SUCCESS", "FAILED"]),
    reference: z.string().optional(),
    error: z.string().optional(),
  })),
});

// ─── API Envelope ───────────────────────────────────────────────────────────

export const errorResponseSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
  correlationId: z.string().uuid(),
});

// ─── Trip Invitations ──────────────────────────────────────────────────────

export const tripInvitationStatusSchema = z.enum([
  "PENDING", "ACCEPTED", "DECLINED", "REVOKED", "EXPIRED",
]);

export const createTripInvitationSchema = z.object({
  recipientEmail: z.string().trim().email().max(256),
  expiresAt: z.string().datetime(),
}).strict();

export const tripInvitationCreateResponseSchema = z.object({
  invitationId: uuidSchema,
  inviteToken: z.string().min(32).max(256),
  expiresAt: z.string().datetime(),
});

export const tripInvitationSummarySchema = z.object({
  id: uuidSchema,
  tripId: uuidSchema,
  invitedUserId: uuidSchema.nullable(),
  invitedByUserId: uuidSchema,
  status: tripInvitationStatusSchema,
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const acceptInvitationResponseSchema = z.object({
  tripId: uuidSchema,
  membership: tripRoleSchema,
  defaultThread: z.object({
    id: uuidSchema,
    tripId: uuidSchema,
    isDefault: z.literal(true),
  }).strict(),
});

// This is deliberately not a Trip detail response. It is the smallest
// authenticated, token-bound view required to make an invitation decision.
export const tripInvitationPreviewResponseSchema = z.object({
  trip: z.object({
    name: z.string().min(1).max(256),
    status: tripStatusSchema,
    destinationCandidates: z.array(z.string().min(1)).max(5),
    travelDateStart: dateStr.nullable(),
    travelDateEnd: dateStr.nullable(),
  }).strict(),
  membership: z.literal("MEMBER"),
  isRequired: z.literal(true),
  expiresAt: z.string().datetime(),
}).strict();

export const declineInvitationResponseSchema = z.object({
  declined: z.literal(true),
}).strict();

// ─── Exploration & Active Trip ─────────────────────────────────────────────

// Exploration start carries only the client's idempotency key.  No message
// body, place, profile, or nationality data crosses this boundary, so audit
// and log lines stay free of PII and trip business state.
export const explorationStartRequestSchema = z.object({
  requestId: uuidSchema,
}).strict();

export const explorationStartResponseSchema = z.object({
  trip: z.object({
    id: uuidSchema,
    name: z.string(),
    status: z.literal("DRAFT"),
    departureCities: z.array(z.string()).length(0),
    destinationCandidates: z.array(z.string()).length(0),
    travelDateStart: z.null(),
    travelDateEnd: z.null(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict(),
  defaultThread: z.object({
    id: uuidSchema,
    tripId: uuidSchema,
    scope: z.literal("TRIP"),
    isDefault: z.literal(true),
  }).strict(),
});

// Activate mirrors `createTripSchema` (the full brief validation) so the only
// way out of DRAFT is a structurally complete brief.
// Phase 1 — solo trips may activate with a single destination candidate
// (validated per-mode by `assertTripModeForBrief` in
// `services/trip-mode-service.ts`).
export const tripActivationRequestSchema = z.object({
  departureCities: z.array(z.string().trim().min(1).max(64)).min(1).max(3),
  destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(1).max(5),
  travelDateStart: dateStr.nullable().optional(),
  travelDateEnd: dateStr.nullable().optional(),
  travelDays: z.number().int().min(1).max(365).optional(),
  titleLocale: z.enum(["en", "zh"]),
}).strict();

export const updateDraftTripBriefRequestSchema = z.object({
  departureCities: z.array(z.string().trim().min(1).max(64)).min(1).max(3).optional(),
  destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(1).max(5).optional(),
  replaceDestinationCandidates: z.boolean().optional(),
  travelDateStart: dateStr.nullable().optional(),
  travelDateEnd: dateStr.nullable().optional(),
  travelDays: z.number().int().min(1).max(365).optional(),
  titleLocale: z.enum(["en", "zh"]),
}).strict().refine((value) => value.departureCities !== undefined || value.destinationCandidates !== undefined || value.travelDateStart !== undefined || value.travelDateEnd !== undefined || value.travelDays !== undefined);

export const updateDraftTripBriefResponseSchema = z.object({
  trip: z.object({
    id: uuidSchema, name: z.string(), nameSource: z.enum(["AUTO", "MANUAL"]), status: z.literal("DRAFT"),
    departureCities: z.array(z.string()), destinationCandidates: z.array(z.string()),
    travelDateStart: dateStr.nullable(), travelDateEnd: dateStr.nullable(),
    travelDays: z.number().int().nullable(), updatedAt: z.string().datetime(),
  }).strict(),
});

export const updateTripTitleRequestSchema = z.object({
  name: z.string().trim().min(1).max(256),
}).strict();

export const updateTripTitleResponseSchema = z.object({
  trip: z.object({
    id: uuidSchema,
    name: z.string(),
    nameSource: z.literal("MANUAL"),
    titleLocale: z.null(),
    updatedAt: z.string().datetime(),
  }).strict(),
});

export const tripActivationResponseSchema = z.object({
  trip: z.object({
    id: uuidSchema,
    name: z.string(),
    status: z.literal("PLANNING"),
    departureCities: z.array(z.string()),
    destinationCandidates: z.array(z.string()),
    travelDateStart: dateStr.nullable(),
    travelDateEnd: dateStr.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict(),
  planningRun: z.object({ runId: uuidSchema, snapshotId: uuidSchema }).strict().optional(),
});

export function toJsonSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

export type Profile = z.infer<typeof profileSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type LatestPlan = z.infer<typeof latestPlanSchema>;
export type NextAction = z.infer<typeof nextActionSchema>;
export type TripSummary = z.infer<typeof tripSummarySchema>;
export type ProjectDisplayState = z.infer<typeof projectDisplayStateSchema>;
export type TripsResponse = z.infer<typeof tripsResponseSchema>;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type ChatMessageRedacted = z.infer<typeof chatMessageRedactedSchema>;
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;
export type ConversationPlace = z.infer<typeof conversationPlaceSchema>;
export type ConversationTurnRequest = z.infer<typeof conversationTurnRequestSchema>;
export type ConversationIntent = z.infer<typeof conversationIntentSchema>;
export type OwnerConversationMessage = z.infer<typeof ownerConversationMessageSchema>;
export type ConversationResponseMode = z.infer<typeof conversationResponseModeSchema>;
export type ConversationTurnAcceptedResponse = z.infer<typeof conversationTurnAcceptedResponseSchema>;
export type TripSearchPreferencesRequest = z.infer<typeof tripSearchPreferencesRequestSchema>;
export type TripStaySearchPreferencesRequest = z.infer<typeof tripStaySearchPreferencesRequestSchema>;
export type AgentTaskOperation = z.infer<typeof agentTaskOperationSchema>;
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
export type ApiErrorResponse = z.infer<typeof errorResponseSchema>;
export type LocationIntroductionRequest = z.infer<typeof locationIntroductionRequestSchema>;
export type LocationIntroductionReady = z.infer<typeof locationIntroductionReadySchema>;
export type LocationIntroductionGenerating = z.infer<typeof locationIntroductionGeneratingSchema>;
export type LocationIntroductionResponse = z.infer<typeof locationIntroductionResponseSchema>;

// ─── Team Agent 协作编排 Phase 0 — Trip constraint / adoption DTOs ──────────
// 对应 `docs/team-agent-orchestration-implementation.md` §3 / §5。
// 字段值(value_json)的最终 shape 由服务端经
// `apps/api/src/policy/constraint-field-catalog.ts#parseConstraintField`
// 用对应目录条目的 Zod schema 解析后才能落库；这里 schema 仅定义 envelope。

export const constraintVisibilitySchema = z.enum([
  "TEAM_VISIBLE",
  "ORCHESTRATOR_CONFIDENTIAL",
]);
export const constraintStrengthSchema = z.enum(["HARD", "SOFT"]);
export const constraintProposalStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "DISMISSED",
  "REVOKED",
]);
export const planAdoptionDecisionSchema = z.enum(["ACCEPT", "NEEDS_CHANGES"]);

export const tripConstraintProposalSourceKindSchema = z.enum([
  "PERSONAL_AGENT",
  "OWNER_FORM",
]);

export const tripConstraintProposalSchema = z.object({
  id: uuidSchema,
  tripId: uuidSchema,
  ownerUserId: uuidSchema,
  fieldKey: z.string().min(1).max(64),
  valueJson: z.unknown(),
  strength: constraintStrengthSchema,
  proposedVisibility: constraintVisibilitySchema,
  sourceKind: tripConstraintProposalSourceKindSchema,
  status: constraintProposalStatusSchema,
  batchId: uuidSchema.nullable(),
  originThreadId: uuidSchema.nullable(),
  originRunId: uuidSchema.nullable(),
  candidateVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
}).strict();

export const tripConstraintFactSchema = z.object({
  id: uuidSchema,
  tripId: uuidSchema,
  ownerUserId: uuidSchema,
  fieldKey: z.string().min(1).max(64),
  valueJson: z.unknown(),
  strength: constraintStrengthSchema,
  visibility: constraintVisibilitySchema,
  revision: z.number().int().positive(),
  sourceProposalId: uuidSchema.nullable(),
  status: z.enum(["ACTIVE", "SUPERSEDED", "REVOKED"]),
  createdAt: z.string().datetime(),
  supersededAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
}).strict();

export const planAdoptionVoteSchema = z.object({
  planId: uuidSchema,
  userId: uuidSchema,
  decision: planAdoptionDecisionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const planAdoptionVotesResponseSchema = z.object({
  planId: uuidSchema,
  requiredMemberIds: z.array(uuidSchema),
  votes: z.array(planAdoptionVoteSchema),
  result: z.enum(["PENDING", "ACCEPTED", "BLOCKED"]),
}).strict();

export const projectedConstraintSchema = z.object({
  fieldKey: z.string().min(1).max(64),
  valueJson: z.unknown(),
  strength: constraintStrengthSchema,
  visibility: constraintVisibilitySchema,
  sourceType: z.enum(["PROFILE_CONSENT", "TRIP_FACT"]),
  sourceId: z.string().min(1),
  revision: z.number().int().positive().optional(),
}).strict();

export const constraintSnapshotProjectionManifestEntrySchema = z.object({
  sourceType: z.enum(["PROFILE_CONSENT", "TRIP_FACT"]),
  sourceId: uuidSchema,
  revision: z.number().int().positive(),
  visibility: constraintVisibilitySchema,
}).strict();

/**
 * Schema for `constraint_snapshots.authorized_data` (v2). Phase 1 起 `MemoryProjectionBuilder`
 * 写入此 shape；reader 端 `assertFieldAllowed` 与 `validatePlanOutput` 仍消费 v1 path，
 * 通过 `schemaVersion` 做条件分流。`memberAliases` 是 run-scoped 临时键，model 不得回填 userId。
 */
export const constraintSnapshotDataV2Schema = z.object({
  schemaVersion: z.literal(2),
  memberAliases: z.record(z.string().uuid(), z.string().min(1).max(64)),
  teamVisible: z.record(z.string(), z.array(projectedConstraintSchema)),
  orchestratorConfidential: z.record(z.string(), z.array(projectedConstraintSchema)),
  projectionManifest: z.array(constraintSnapshotProjectionManifestEntrySchema),
  departureCities: z.array(z.string().min(1)),
  destinationCandidates: z.array(z.string().min(1)).min(1),
  travelDateStart: dateStr.optional(),
  travelDateEnd: dateStr.optional(),
}).strict();

/**
 * `authorized_data._meta.memory` — the only route personal memory takes to the
 * Shared Trip Agent (docs/long-term-memory-implementation.md §4.4).
 *
 * Members are keyed by their run-scoped alias, never by user id: the rest of
 * the v2 snapshot already aliases members, and projecting raw ids here would
 * undo that for the one section that carries preferences.
 *
 * Values are whatever the field's catalog schema allows, so they stay
 * `unknown` here; the catalog is what decides a field may appear at all.
 */
export const memoryProjectionSchema = z.object({
  members: z.record(z.string().min(1), z.object({
    /** Stable profile facts this member consented to export to this trip. */
    profileFacts: z.record(z.string(), z.unknown()),
    /** Team-visible this-trip overrides; safe to reference in an explanation. */
    tripOverrides: z.record(z.string(), z.unknown()),
    /**
     * Overrides marked ORCHESTRATOR_CONFIDENTIAL: usable when planning, and
     * barred from peer responses, plan explanations and telemetry (§3.3).
     *
     * Kept in its own key rather than mixed into `tripOverrides` because the
     * separation has to survive the trip to the snapshot — a consumer reading a
     * flat map cannot tell which values it is allowed to repeat.
     */
    confidentialOverrides: z.record(z.string(), z.unknown()),
  }).strict()),
  /** Decisions belonging to the trip rather than to any one member. */
  groupDecisions: z.record(z.string(), z.unknown()),
}).strict();

export const tripConstraintProposalsResponseSchema = z.object({
  proposals: z.array(tripConstraintProposalSchema),
}).strict();

export const tripConstraintsResponseSchema = z.object({
  tripId: uuidSchema,
  teamVisibleFacts: z.array(tripConstraintFactSchema),
  // 注：confidential facts 仅在 owner 调 `/constraints/me` 时返回，本 DTO 不含该字段。
}).strict();

export const tripConstraintsOwnerResponseSchema = z.object({
  tripId: uuidSchema,
  allFacts: z.array(tripConstraintFactSchema),
}).strict();

export const createTripConstraintProposalRequestSchema = z.object({
  fieldKey: z.string().min(1).max(64),
  valueJson: z.unknown(),
  proposedVisibility: constraintVisibilitySchema,
  proposedStrength: constraintStrengthSchema,
  sourceKind: tripConstraintProposalSourceKindSchema.default("OWNER_FORM"),
  idempotencyKey: uuidSchema.optional(),
}).strict();

export const confirmTripConstraintProposalRequestSchema = z.object({
  visibility: constraintVisibilitySchema,
  strength: constraintStrengthSchema,
  idempotencyKey: uuidSchema.optional(),
}).strict();

export const upsertTripConstraintFactRequestSchema = z.object({
  fieldKey: z.string().min(1).max(64),
  valueJson: z.unknown(),
  visibility: constraintVisibilitySchema,
  strength: constraintStrengthSchema,
  expectedRevision: z.number().int().positive().optional(),
  idempotencyKey: uuidSchema.optional(),
}).strict();

export const castAdoptionVoteRequestSchema = z.object({
  decision: planAdoptionDecisionSchema,
  idempotencyKey: uuidSchema.optional(),
}).strict();

// ─── Member conversation handoff (docs/member-conversation-handoff-implementation.md §5.2) ───
// 严格不接受 value、userId、threadId、snapshotId、planId、provider 参数或任意 JSON。
// 成员只能在 UI 中取消单项选择，最终值只来自已持久化的 proposal。
const constraintHandoffSelectionSchema = z.object({
  proposalId: uuidSchema,
  visibility: constraintVisibilitySchema,
  strength: constraintStrengthSchema,
}).strict();

export const constraintHandoffConfirmRequestSchema = z.object({
  requestId: uuidSchema,
  candidateVersion: z.number().int().positive(),
  selections: z.array(constraintHandoffSelectionSchema).min(1).max(8),
}).strict();

export const constraintHandoffConfirmResponseSchema = z.object({
  runId: uuidSchema,
  snapshotId: uuidSchema,
  operation: z.enum(["PLAN", "REPLAN"]),
  status: z.literal("QUEUED"),
}).strict();

export const constraintHandoffBatchResponseSchema = z.object({
  tripId: uuidSchema,
  batchId: uuidSchema,
  candidateVersion: z.number().int().positive(),
  batch: z.array(tripConstraintProposalSchema),
  residualInferenceWarnings: z.array(z.string()),
}).strict();

export type ConstraintVisibility = z.infer<typeof constraintVisibilitySchema>;
export type ConstraintStrength = z.infer<typeof constraintStrengthSchema>;
export type ConstraintProposalStatus = z.infer<typeof constraintProposalStatusSchema>;
export type PlanAdoptionDecision = z.infer<typeof planAdoptionDecisionSchema>;
export type TripConstraintProposalSourceKind = z.infer<typeof tripConstraintProposalSourceKindSchema>;
export type TripConstraintProposal = z.infer<typeof tripConstraintProposalSchema>;
export type TripConstraintFact = z.infer<typeof tripConstraintFactSchema>;
export type PlanAdoptionVote = z.infer<typeof planAdoptionVoteSchema>;
export type PlanAdoptionVotesResponse = z.infer<typeof planAdoptionVotesResponseSchema>;
export type ProjectedConstraint = z.infer<typeof projectedConstraintSchema>;
export type ConstraintSnapshotProjectionManifestEntry = z.infer<typeof constraintSnapshotProjectionManifestEntrySchema>;
export type ConstraintSnapshotDataV2 = z.infer<typeof constraintSnapshotDataV2Schema>;
export type MemoryProjection = z.infer<typeof memoryProjectionSchema>;
export type TripConstraintProposalsResponse = z.infer<typeof tripConstraintProposalsResponseSchema>;
export type TripConstraintsResponse = z.infer<typeof tripConstraintsResponseSchema>;
export type TripConstraintsOwnerResponse = z.infer<typeof tripConstraintsOwnerResponseSchema>;
export type CreateTripConstraintProposalRequest = z.infer<typeof createTripConstraintProposalRequestSchema>;
export type ConfirmTripConstraintProposalRequest = z.infer<typeof confirmTripConstraintProposalRequestSchema>;
export type UpsertTripConstraintFactRequest = z.infer<typeof upsertTripConstraintFactRequestSchema>;
export type CastAdoptionVoteRequest = z.infer<typeof castAdoptionVoteRequestSchema>;
export type ConstraintHandoffConfirmRequest = z.infer<typeof constraintHandoffConfirmRequestSchema>;
export type ConstraintHandoffConfirmResponse = z.infer<typeof constraintHandoffConfirmResponseSchema>;
export type ConstraintHandoffBatchResponse = z.infer<typeof constraintHandoffBatchResponseSchema>;
