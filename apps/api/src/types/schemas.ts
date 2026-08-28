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
    distanceKm: z.number().nonnegative().nullable(),
  }),
  locationReferenceBaseSchema.extend({ outcome: z.literal("NO_REFERENCE") }),
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
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
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

export const conversationResponseModeSchema = z.enum(["MODEL", "SAFE_REFUSAL"]);

export const agentTaskOperationSchema = z.enum(["CONVERSATION", "PLAN", "REPLAN"]);
export const agentTaskStatusSchema = z.enum([
  "QUEUED", "RUNNING", "CANCEL_REQUESTED", "COMPLETED", "FAILED", "CANCELLED", "STALE",
]);
export const agentRunPhaseSchema = z.enum([
  "ACCEPTED", "RESEARCHING", "GENERATING", "VALIDATING", "PERSISTING",
  "RETRYING", "COMPLETED", "STALE", "FAILED",
]);
export const agentRunErrorCodeSchema = z.enum([
  "NETWORK", "UPSTREAM_5XX", "UPSTREAM_FAILURE", "TIMEOUT", "SCHEMA_PARSE",
  "POLICY_DENIED", "CANCELLED", "EXPIRED", "RETRY_EXHAUSTED", "INTERNAL",
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
  "PENDING", "ACCEPTED", "REVOKED", "EXPIRED",
]);

export const createTripInvitationSchema = z.object({
  invitedUserId: uuidSchema,
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
  invitedUserId: uuidSchema,
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

// ─── Exploration & Draft Trip ──────────────────────────────────────────────

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
export const tripActivationRequestSchema = z.object({
  departureCities: z.array(z.string().trim().min(1).max(64)).min(1).max(3),
  destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(2).max(5),
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
export type AgentTaskOperation = z.infer<typeof agentTaskOperationSchema>;
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
export type ApiErrorResponse = z.infer<typeof errorResponseSchema>;
