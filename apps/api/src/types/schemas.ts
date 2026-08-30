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
  destinationCandidates: z.array(z.string().min(1)).min(2).max(5),
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
    archivedAt: z.string().datetime().nullable(),
    archiveReason: tripArchiveReasonSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
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

export const agentTaskOperationSchema = z.enum(["CONVERSATION", "PLAN", "REPLAN", "RESEARCH"]);
export const agentTaskStatusSchema = z.enum([
  "QUEUED", "RUNNING", "CANCEL_REQUESTED", "COMPLETED", "FAILED", "CANCELLED", "STALE",
]);
export const agentRunPhaseSchema = z.enum([
  "ACCEPTED", "RESEARCHING", "GENERATING", "VALIDATING", "PERSISTING",
  "RETRYING", "COMPLETED", "STALE", "FAILED",
]);
export const agentRunErrorCodeSchema = z.enum([
  "NETWORK", "UPSTREAM_5XX", "UPSTREAM_FAILURE", "TIMEOUT", "SCHEMA_PARSE",
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

/** `research.intent_extracted` SSE event — carries the model-extracted research draft. */
export const researchIntentExtractedEventSchema = streamBaseSchema.extend({
  event: z.literal("research.intent_extracted"),
  intent: personalResearchIntentSchema,
}).strict();

/**
 * Safe DTO returned by `GET /api/v1/trips/:tripId/research/latest`. Carries
 * only the persisted `planning_research_results` row + service-gap summary —
 * never raw provider payloads, snapshot values, or chat content.
 */
export const researchResultResponseSchema = z.object({
  id: uuidSchema,
  tripId: uuidSchema,
  snapshotId: uuidSchema,
  agentTaskRunId: uuidSchema.nullable(),
  status: z.enum(["COMPLETE", "COMPLETED_WITH_GAPS"]),
  serviceGaps: z.array(z.record(z.string(), z.unknown())).max(64),
  resultPlanId: uuidSchema.nullable(),
  createdAt: z.string().datetime(),
}).strict();

export const latestResearchResultResponseSchema = z.object({
  result: researchResultResponseSchema.nullable(),
}).strict();

export const agentStreamEventSchema = z.discriminatedUnion("event", [
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
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("trip.brief_proposed"),
    proposal: z.object({
      destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(1).max(1).optional(),
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
  researchStageEventSchema,
  researchIntentExtractedEventSchema,
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
    status: z.literal("PLANNING"),
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
  titleLocale: z.enum(["en", "zh"]),
}).strict();

export const updateDraftTripBriefRequestSchema = z.object({
  destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(1).max(1).optional(),
  travelDays: z.number().int().min(1).max(365).optional(),
  titleLocale: z.enum(["en", "zh"]),
}).strict().refine((value) => value.destinationCandidates !== undefined || value.travelDays !== undefined);

export const updateDraftTripBriefResponseSchema = z.object({
  trip: z.object({
    id: uuidSchema, name: z.string(), nameSource: z.enum(["AUTO", "MANUAL"]), status: z.literal("DRAFT"),
    destinationCandidates: z.array(z.string()), travelDays: z.number().int().nullable(), updatedAt: z.string().datetime(),
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
