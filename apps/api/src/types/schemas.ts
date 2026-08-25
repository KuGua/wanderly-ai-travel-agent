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
  memberUserIds: z.array(uuidSchema).min(2).max(10),
});

export const tripStatusSchema = z.enum(["PLANNING", "CONFIRMED", "BOOKED", "CANCELLED", "STALE"]);
export const tripRoleSchema = z.enum(["CREATOR", "MEMBER"]);

export const projectDisplayStateSchema = z.enum([
  "ACTION_REQUIRED",
  "IN_PROGRESS",
  "COMPLETED",
  "ARCHIVED",
  "CANCELLED",
]);

export const latestPlanStatusSchema = z.enum(["DRAFT", "ACTIVE", "STALE", "SUPERSEDED"]);

export const nextActionTypeSchema = z.enum([
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

export const createThreadSchema = z.object({
  title: z.string().min(1).max(256),
  tripId: uuidSchema.optional(),
}).strict();

export const threadSummarySchema = z.object({
  id: uuidSchema,
  ownerUserId: uuidSchema,
  tripId: uuidSchema.nullable(),
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
  sourceType: z.enum(["FIXTURE", "INSPIRATION"]),
}).strict();

export const conversationTurnRequestSchema = z.object({
  requestId: uuidSchema,
  question: z.string().trim().min(1).max(4000),
  place: conversationPlaceSchema.optional(),
}).strict();

export const ownerConversationMessageSchema = z.object({
  id: uuidSchema,
  role: chatMessageRoleSchema,
  content: z.string(),
  createdAt: z.string().datetime(),
});

export const conversationResponseModeSchema = z.enum(["MODEL", "SAFE_REFUSAL"]);

export const conversationTurnResponseSchema = z.object({
  threadId: uuidSchema,
  userMessage: ownerConversationMessageSchema.extend({ role: z.literal("USER") }),
  assistantMessage: ownerConversationMessageSchema.extend({ role: z.literal("ASSISTANT") }),
  responseMode: conversationResponseModeSchema,
});

export const ownerConversationResponseSchema = z.object({
  thread: threadSummarySchema,
  messages: z.array(ownerConversationMessageSchema),
});

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
export type OwnerConversationMessage = z.infer<typeof ownerConversationMessageSchema>;
export type ConversationResponseMode = z.infer<typeof conversationResponseModeSchema>;
export type ConversationTurnResponse = z.infer<typeof conversationTurnResponseSchema>;
export type ApiErrorResponse = z.infer<typeof errorResponseSchema>;
