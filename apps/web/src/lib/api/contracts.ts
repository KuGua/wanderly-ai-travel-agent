import { z } from "zod";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const accommodationStyleSchema = z.enum(["city_center", "budget", "luxury"]);

export const profileSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  nationality: z.string().nullable(),
  dateOfBirth: dateSchema.nullable(),
  interests: z.array(z.string()).nullable(),
  accommodationStyle: accommodationStyleSchema.nullable(),
  budgetMaxUsd: z.number().int().positive().nullable(),
  noRedEye: z.boolean().nullable(),
  mobilityNotes: z.string().nullable(),
  availableDepartureDates: z.array(dateSchema).nullable(),
  departureCity: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const profileResponseSchema = z.object({
  profile: profileSchema.nullable(),
});

export const updateProfileInputSchema = z.object({
  nationality: z.string().max(64).optional(),
  dateOfBirth: dateSchema.optional(),
  interests: z.array(z.string()).optional(),
  accommodationStyle: accommodationStyleSchema.optional(),
  budgetMaxUsd: z.number().int().positive().optional(),
  noRedEye: z.boolean().optional(),
  mobilityNotes: z.string().optional(),
  availableDepartureDates: z.array(dateSchema).optional(),
  departureCity: z.string().max(64).optional(),
}).strict();

export const updateProfileResponseSchema = z.object({
  message: z.literal("Profile updated"),
  profile: profileSchema,
});

export const tripStatusSchema = z.enum([
  "DRAFT",
  "PLANNING",
  "CONFIRMED",
  "BOOKED",
  "CANCELLED",
  "STALE",
]);

export const tripRoleSchema = z.enum(["CREATOR", "MEMBER"]);

export const tripSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: tripStatusSchema,
  departureCities: z.array(z.string()),
  destinationCandidates: z.array(z.string()),
  travelDateStart: dateSchema.nullable(),
  travelDateEnd: dateSchema.nullable(),
  memberCount: z.number().int().nonnegative(),
  role: tripRoleSchema,
  createdAt: z.string().datetime(),
});

export const tripsResponseSchema = z.object({
  trips: z.array(tripSummarySchema),
});

export const threadSchema = z.object({
  id: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  tripId: z.string().uuid(),
  scope: z.enum(["TRIP"]).default("TRIP"),
  isDefault: z.boolean().default(false),
  title: z.string(),
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});

export const threadsResponseSchema = z.object({
  threads: z.array(threadSchema),
});

export const createTripThreadInputSchema = z.object({
  title: z.string().trim().min(1).max(256),
}).strict();

// Thread creation returns the same persisted summary used in thread lists.
// This keeps the active trip/thread metadata available to the UI immediately.
export const createThreadResponseSchema = threadSchema;

// Single-trip detail DTO returned by GET /api/v1/trips/:tripId.
export const tripDetailSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdBy: z.string().uuid(),
  status: tripStatusSchema,
  departureCities: z.array(z.string()),
  destinationCandidates: z.array(z.string()),
  travelDateStart: dateSchema.nullable(),
  travelDateEnd: dateSchema.nullable(),
  memberCount: z.number().int().nonnegative(),
  role: tripRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const tripDetailResponseSchema = z.object({
  trip: tripDetailSchema,
});

export const conversationPlaceSchema = z.object({
  sourceId: z.string().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(160),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  sourceType: z.enum(["REFERENCE", "INSPIRATION"]),
}).strict();

export const conversationMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["USER", "ASSISTANT"]),
  content: z.string(),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export const conversationResponseModeSchema = z.enum(["MODEL", "SAFE_REFUSAL"]);

export const conversationIntentSchema = z.enum(["auto_intro", "user_typed"]);

export const conversationTurnRequestSchema = z.object({
  requestId: z.string().uuid(),
  question: z.string().trim().min(1).max(4000),
  place: conversationPlaceSchema.optional(),
  intent: conversationIntentSchema.optional(),
}).strict();

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
  threadId: z.string().uuid(),
  runId: z.string().uuid(),
  operation: z.literal("CONVERSATION"),
  status: z.literal("QUEUED"),
  generationAttempt: z.literal(0),
  userMessage: conversationMessageSchema.extend({ role: z.literal("USER") }),
});

export const ownerConversationResponseSchema = z.object({
  thread: threadSchema,
  messages: z.array(conversationMessageSchema),
});

export const agentRunResponseSchema = z.object({
  runId: z.string().uuid(),
  operation: agentTaskOperationSchema,
  status: agentTaskStatusSchema,
  generationAttempt: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  errorCode: agentRunErrorCodeSchema.nullable(),
  assistantMessageId: z.string().uuid().nullable(),
  resultPlanId: z.string().uuid().nullable(),
});

const streamBaseSchema = z.object({
  runId: z.string().uuid(),
  generationAttempt: z.number().int().nonnegative(),
});

export const agentStreamEventSchema = z.discriminatedUnion("event", [
  streamBaseSchema.extend({ event: z.literal("turn.started") }).strict(),
  streamBaseSchema.extend({ event: z.literal("run.phase"), phase: agentRunPhaseSchema }).strict(),
  streamBaseSchema.extend({
    event: z.literal("message.delta"),
    sequence: z.number().int().nonnegative(),
    delta: z.string().min(1).max(2048),
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("turn.completed"),
    assistantMessageId: z.string().uuid().optional(),
    resultPlanId: z.string().uuid().optional(),
  }).strict(),
  streamBaseSchema.extend({ event: z.literal("turn.cancelled") }).strict(),
  streamBaseSchema.extend({ event: z.literal("turn.stale"), code: agentRunErrorCodeSchema }).strict(),
  streamBaseSchema.extend({
    event: z.literal("turn.failed"),
    code: agentRunErrorCodeSchema,
    retryable: z.boolean(),
  }).strict(),
]);

export const apiErrorResponseSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
  correlationId: z.string().uuid(),
});

// Exploration session: first chat message in /home creates a DRAFT Trip
// on the server. The browser only carries the resulting trip / thread ids
// in memory — never in URL, localStorage, or sessionStorage.
export const explorationStartRequestSchema = z.object({
  requestId: z.string().uuid(),
}).strict();

export const explorationDraftTripSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.literal("DRAFT"),
  departureCities: z.array(z.string()).length(0),
  destinationCandidates: z.array(z.string()).length(0),
  travelDateStart: z.null(),
  travelDateEnd: z.null(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const explorationStartResponseSchema = z.object({
  trip: explorationDraftTripSchema,
  defaultThread: z.object({
    id: z.string().uuid(),
    tripId: z.string().uuid(),
    scope: z.literal("TRIP"),
    isDefault: z.literal(true),
  }).strict(),
});

// Activate mirrors the server `tripActivationRequestSchema`. The brief
// must satisfy the same constraints as `POST /trips` (at least one
// departure city, two to five destinations).
export const tripActivationRequestSchema = z.object({
  departureCities: z.array(z.string().trim().min(1).max(64)).min(1).max(3),
  destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(2).max(5),
  travelDateStart: dateSchema.nullable().optional(),
  travelDateEnd: dateSchema.nullable().optional(),
  titleLocale: z.enum(["en", "zh"]),
}).strict();

export const tripActivationResponseSchema = z.object({
  trip: z.object({
    id: z.string().uuid(),
    name: z.string(),
    status: z.literal("PLANNING"),
    departureCities: z.array(z.string()),
    destinationCandidates: z.array(z.string()),
    travelDateStart: dateSchema.nullable(),
    travelDateEnd: dateSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict(),
});

export const updateTripTitleInputSchema = z.object({ name: z.string().trim().min(1).max(256) }).strict();
export const updateTripTitleResponseSchema = z.object({
  trip: z.object({
    id: z.string().uuid(), name: z.string(), nameSource: z.literal("MANUAL"), titleLocale: z.null(), updatedAt: z.string().datetime(),
  }).strict(),
});

export const locationReferenceInputSchema = z.object({
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
    country: z.string().min(1), countryCode: z.string().length(2).nullable(),
    admin1: z.string().min(1).nullable(), admin1Code: z.string().min(1).nullable(),
    nearestCity: z.string().min(1).nullable(),
    nearestCityCoordinates: z.object({
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
    }).strict().nullable(),
    distanceKm: z.number().nonnegative().nullable(),
  }),
  locationReferenceBaseSchema.extend({ outcome: z.literal("NO_REFERENCE") }),
]);

export type Profile = z.infer<typeof profileSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;
export type UpdateProfileResponse = z.infer<typeof updateProfileResponseSchema>;
export type TripSummary = z.infer<typeof tripSummarySchema>;
export type TripsResponse = z.infer<typeof tripsResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type LocationReferenceInput = z.infer<typeof locationReferenceInputSchema>;
export type LocationReferenceResponse = z.infer<typeof locationReferenceResponseSchema>;
export type ExplorationStartRequest = z.infer<typeof explorationStartRequestSchema>;
export type ExplorationStartResponse = z.infer<typeof explorationStartResponseSchema>;
export type TripActivationRequest = z.infer<typeof tripActivationRequestSchema>;
export type TripActivationResponse = z.infer<typeof tripActivationResponseSchema>;
export type UpdateTripTitleInput = z.infer<typeof updateTripTitleInputSchema>;
export type UpdateTripTitleResponse = z.infer<typeof updateTripTitleResponseSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type ThreadsResponse = z.infer<typeof threadsResponseSchema>;
export type CreateTripThreadInput = z.infer<typeof createTripThreadInputSchema>;
export type CreateThreadResponse = z.infer<typeof createThreadResponseSchema>;
export type TripDetail = z.infer<typeof tripDetailSchema>;
export type TripDetailResponse = z.infer<typeof tripDetailResponseSchema>;
export type ConversationPlace = z.infer<typeof conversationPlaceSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationResponseMode = z.infer<typeof conversationResponseModeSchema>;
export type ConversationTurnRequest = z.infer<typeof conversationTurnRequestSchema>;
export type ConversationTurnAcceptedResponse = z.infer<typeof conversationTurnAcceptedResponseSchema>;
export type OwnerConversationResponse = z.infer<typeof ownerConversationResponseSchema>;
export type AgentRun = z.infer<typeof agentRunResponseSchema>;
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;
