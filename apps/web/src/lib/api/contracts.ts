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
export const tripArchiveReasonSchema = z.enum(["USER_ARCHIVED", "DATE_ELAPSED"]);

export const tripRoleSchema = z.enum(["CREATOR", "MEMBER"]);

export const tripSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: tripStatusSchema,
  departureCities: z.array(z.string()),
  destinationCandidates: z.array(z.string()),
  travelDateStart: dateSchema.nullable(),
  travelDateEnd: dateSchema.nullable(),
  archivedAt: z.string().datetime().nullable().optional(),
  archiveReason: tripArchiveReasonSchema.nullable().optional(),
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
  archivedAt: z.string().datetime().nullable().optional(),
  archiveReason: tripArchiveReasonSchema.nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const tripMemberSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  role: tripRoleSchema,
  isRequired: z.boolean(),
  joinedAt: z.string().datetime(),
});

export const tripDetailResponseSchema = z.object({
  trip: tripDetailSchema,
  callerRole: tripRoleSchema,
  members: z.array(tripMemberSchema),
});

export const createTripInvitationInputSchema = z.object({
  recipientEmail: z.string().trim().email().max(256),
  expiresAt: z.string().datetime(),
}).strict();

export const tripInvitationCreateResponseSchema = z.object({
  invitationId: z.string().uuid(),
  inviteToken: z.string().min(32).max(256),
  expiresAt: z.string().datetime(),
}).strict();

export const invitationPreviewResponseSchema = z.object({
  trip: z.object({
    name: z.string().min(1).max(256),
    destinationCandidates: z.array(z.string().min(1)).max(5),
    travelDateStart: dateSchema.nullable(),
    travelDateEnd: dateSchema.nullable(),
  }).strict(),
  membership: z.literal("MEMBER"),
  isRequired: z.literal(true),
  expiresAt: z.string().datetime(),
}).strict();

export const acceptInvitationResponseSchema = z.object({
  tripId: z.string().uuid(),
  membership: z.literal("MEMBER"),
  defaultThread: z.object({ id: z.string().uuid(), tripId: z.string().uuid(), isDefault: z.literal(true) }).strict(),
}).strict();

export const declineInvitationResponseSchema = z.object({ declined: z.literal(true) }).strict();

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
  streamBaseSchema.extend({
    event: z.literal("trip.brief_proposed"),
    proposal: z.object({
      destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(1).max(1).optional(),
      travelDays: z.number().int().min(1).max(365).optional(),
    }).strict(),
  }).strict(),
  streamBaseSchema.extend({ event: z.literal("turn.cancelled") }).strict(),
  streamBaseSchema.extend({ event: z.literal("turn.stale"), code: agentRunErrorCodeSchema }).strict(),
  streamBaseSchema.extend({
    event: z.literal("turn.failed"),
    code: agentRunErrorCodeSchema,
    retryable: z.boolean(),
  }).strict(),
  // Phase 6 / Personal Trip Orchestrator — research-specific SSE events.
  // Personal research schemas are defined below the discriminated union, so
  // we re-declare lightweight inline shapes for these two SSE members
  // (kept in sync with the canonical schemas in §6 of this file).
  streamBaseSchema.extend({
    event: z.literal("research.intent_extracted"),
    intent: z.object({
      kind: z.enum(["RESEARCH_ONLY", "PROPOSE_PLAN"]),
      requestedCapabilities: z.array(z.enum([
        "flight", "accommodation", "hotel", "activities", "places", "navigation", "mobility", "readiness",
      ])).min(1),
      destinationCandidates: z.array(z.string().min(1).max(64)).min(1).max(5).optional(),
    }).strict(),
  }).strict(),
  streamBaseSchema.extend({
    event: z.literal("research.stage"),
    stage: z.enum([
      "SNAPSHOT_CREATED", "RESEARCHING", "VALIDATING", "PERSISTING",
      "COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "STALE",
    ]),
  }).strict(),
]);

// ─── Personal Trip Research command (Phase 6 / docs §4) ───────────────────
export const personalResearchCapabilitySchema = z.enum([
  "flight", "accommodation", "hotel", "activities", "places", "navigation", "mobility", "readiness",
]);
export type PersonalResearchCapability = z.infer<typeof personalResearchCapabilitySchema>;

export const personalResearchKindSchema = z.enum(["RESEARCH_ONLY", "PROPOSE_PLAN"]);
export type PersonalResearchKind = z.infer<typeof personalResearchKindSchema>;

export const personalResearchIntentSchema = z.object({
  kind: personalResearchKindSchema,
  requestedCapabilities: z.array(personalResearchCapabilitySchema).min(1),
  destinationCandidates: z.array(z.string().min(1).max(64)).min(1).max(5).optional(),
}).strict();
export type PersonalResearchIntent = z.infer<typeof personalResearchIntentSchema>;

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
    status: z.literal("PLANNING"),
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
export const updateDraftTripBriefInputSchema = z.object({
  destinationCandidates: z.array(z.string().trim().min(1).max(64)).min(1).max(1).optional(),
  travelDays: z.number().int().min(1).max(365).optional(),
  titleLocale: z.enum(["en", "zh"]),
}).strict().refine((value) => value.destinationCandidates !== undefined || value.travelDays !== undefined);
export const updateDraftTripBriefResponseSchema = z.object({
  trip: z.object({ id: z.string().uuid(), name: z.string(), nameSource: z.enum(["AUTO", "MANUAL"]), status: z.literal("DRAFT"), destinationCandidates: z.array(z.string()), travelDays: z.number().int().nullable(), updatedAt: z.string().datetime() }).strict(),
});
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
    introductionSourceId: z.string().min(1).max(128).nullable().optional(),
    distanceKm: z.number().nonnegative().nullable(),
  }),
  locationReferenceBaseSchema.extend({ outcome: z.literal("NO_REFERENCE") }),
]);

// ─── Location Introduction (anonymous, shared cache) ─────────────────────────
// Mirror of the api/src/types/schemas.ts contract. Keep these two copies in
// lock-step — the web app does not import from the api package.

export const locationIntroductionLocaleSchema = z.enum(["en", "zh"]);

export const locationIntroductionInputSchema = z.object({
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

// ─── Personal long-term memory ───────────────────────────────────────────────
// Mirrors src/routes/profile-memory.ts. Deliberately narrow: no profileId, no
// observation dates, no trip references, no activation score — see
// docs/long-term-memory-implementation.md section 5.4.

export const memoryFactSchema = z.object({
  id: z.string().uuid(),
  fieldKey: z.string().min(1),
  value: z.unknown(),
  category: z.enum(["PREFERENCE", "CONSTRAINT"]),
  source: z.enum(["PROFILE_FORM", "PROPOSAL_CONFIRMATION"]),
  status: z.enum(["ACTIVE", "SUPERSEDED"]),
  updatedAt: z.string().datetime(),
});

/** An unconfirmed candidate. Never render this as an established fact. */
export const memorySuggestionSchema = z.object({
  id: z.string().uuid(),
  fieldKey: z.string().min(1),
  value: z.unknown(),
  observationCount: z.number().int().nonnegative(),
  distinctTripCount: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
});

export const profileMemoryResponseSchema = z.object({
  facts: z.array(memoryFactSchema),
  suggestions: z.array(memorySuggestionSchema),
});

export const updateMemoryFactInputSchema = z.object({ value: z.unknown() }).strict();

export const resolveProposalResponseSchema = z.object({
  status: z.enum(["PENDING", "CONFIRMED", "DISMISSED", "EXPIRED"]),
  factId: z.string().uuid().nullable().optional(),
});

export type MemoryFact = z.infer<typeof memoryFactSchema>;
export type MemorySuggestion = z.infer<typeof memorySuggestionSchema>;
export type ProfileMemoryResponse = z.infer<typeof profileMemoryResponseSchema>;
export type UpdateMemoryFactInput = z.infer<typeof updateMemoryFactInputSchema>;
export type ResolveProposalResponse = z.infer<typeof resolveProposalResponseSchema>;

// ─── Trip-scoped memory ──────────────────────────────────────────────────────
// Mirrors src/routes/trip-memory.ts. A personal override is visible only to its
// owner; a group decision is visible to every active member.

export const tripMemoryFactSchema = z.object({
  id: z.string().uuid(),
  fieldKey: z.string().min(1),
  value: z.unknown(),
  kind: z.enum(["PERSONAL_OVERRIDE", "GROUP_DECISION"]),
  source: z.enum(["OWNER_SAVE", "GROUP_COMMAND"]),
  status: z.enum(["ACTIVE", "SUPERSEDED"]),
  updatedAt: z.string().datetime(),
});

export const tripMemoryOverridesResponseSchema = z.object({
  overrides: z.array(tripMemoryFactSchema),
});

export const tripMemoryGroupResponseSchema = z.object({
  groupDecisions: z.array(tripMemoryFactSchema),
});

export type TripMemoryFact = z.infer<typeof tripMemoryFactSchema>;
export type TripMemoryOverridesResponse = z.infer<typeof tripMemoryOverridesResponseSchema>;
export type TripMemoryGroupResponse = z.infer<typeof tripMemoryGroupResponseSchema>;

export type Profile = z.infer<typeof profileSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;
export type UpdateProfileResponse = z.infer<typeof updateProfileResponseSchema>;
export type TripSummary = z.infer<typeof tripSummarySchema>;
export type TripsResponse = z.infer<typeof tripsResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type LocationReferenceInput = z.infer<typeof locationReferenceInputSchema>;
export type LocationReferenceResponse = z.infer<typeof locationReferenceResponseSchema>;
export type LocationIntroductionInput = z.infer<typeof locationIntroductionInputSchema>;
export type LocationIntroductionReady = z.infer<typeof locationIntroductionReadySchema>;
export type LocationIntroductionGenerating = z.infer<typeof locationIntroductionGeneratingSchema>;
export type LocationIntroductionResponse = z.infer<typeof locationIntroductionResponseSchema>;
export type ExplorationStartRequest = z.infer<typeof explorationStartRequestSchema>;
export type ExplorationStartResponse = z.infer<typeof explorationStartResponseSchema>;
export type TripActivationRequest = z.infer<typeof tripActivationRequestSchema>;
export type TripActivationResponse = z.infer<typeof tripActivationResponseSchema>;
export type UpdateTripTitleInput = z.infer<typeof updateTripTitleInputSchema>;
export type UpdateTripTitleResponse = z.infer<typeof updateTripTitleResponseSchema>;
export type UpdateDraftTripBriefInput = z.infer<typeof updateDraftTripBriefInputSchema>;
export type UpdateDraftTripBriefResponse = z.infer<typeof updateDraftTripBriefResponseSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type ThreadsResponse = z.infer<typeof threadsResponseSchema>;
export type CreateTripThreadInput = z.infer<typeof createTripThreadInputSchema>;
export type CreateThreadResponse = z.infer<typeof createThreadResponseSchema>;
export type TripDetail = z.infer<typeof tripDetailSchema>;
export type TripMember = z.infer<typeof tripMemberSchema>;
export type TripDetailResponse = z.infer<typeof tripDetailResponseSchema>;
export type InvitationPreviewResponse = z.infer<typeof invitationPreviewResponseSchema>;
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;
export type DeclineInvitationResponse = z.infer<typeof declineInvitationResponseSchema>;
export type CreateTripInvitationInput = z.infer<typeof createTripInvitationInputSchema>;
export type TripInvitationCreateResponse = z.infer<typeof tripInvitationCreateResponseSchema>;
export type ConversationPlace = z.infer<typeof conversationPlaceSchema>;
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationResponseMode = z.infer<typeof conversationResponseModeSchema>;
export type ConversationTurnRequest = z.infer<typeof conversationTurnRequestSchema>;
export type ConversationTurnAcceptedResponse = z.infer<typeof conversationTurnAcceptedResponseSchema>;
export type OwnerConversationResponse = z.infer<typeof ownerConversationResponseSchema>;
export type AgentRun = z.infer<typeof agentRunResponseSchema>;
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;

// ─── Team Agent 协作编排 Phase 5 Zod schemas ────────────────────────────────

export const constraintVisibilitySchema = z.enum(["TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"]);
export const constraintStrengthSchema = z.enum(["HARD", "SOFT"]);
export const constraintProposalStatusSchema = z.enum(["PENDING", "CONFIRMED", "DISMISSED", "REVOKED"]);
export const planAdoptionDecisionSchema = z.enum(["ACCEPT", "NEEDS_CHANGES"]);
export const constraintProposalSourceKindSchema = z.enum(["PERSONAL_AGENT", "OWNER_FORM"]);

export const tripConstraintProposalSchema = z.object({
  id: z.string().uuid(),
  tripId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  fieldKey: z.string().min(1),
  valueJson: z.unknown(),
  strength: constraintStrengthSchema,
  proposedVisibility: constraintVisibilitySchema,
  sourceKind: constraintProposalSourceKindSchema,
  status: constraintProposalStatusSchema,
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
}).strict();

export const tripConstraintFactSchema = z.object({
  id: z.string().uuid(),
  tripId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  fieldKey: z.string().min(1),
  valueJson: z.unknown(),
  strength: constraintStrengthSchema,
  visibility: constraintVisibilitySchema,
  revision: z.number().int().positive(),
  sourceProposalId: z.string().uuid().nullable(),
  status: z.enum(["ACTIVE", "SUPERSEDED", "REVOKED"]),
  createdAt: z.string().datetime(),
  supersededAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
}).strict();

export const tripConstraintsResponseSchema = z.object({
  tripId: z.string().uuid(),
  teamVisibleFacts: z.array(tripConstraintFactSchema),
}).strict();

export const tripConstraintsOwnerResponseSchema = z.object({
  tripId: z.string().uuid(),
  allFacts: z.array(tripConstraintFactSchema),
}).strict();

export const tripConstraintProposalsResponseSchema = z.object({
  tripId: z.string().uuid(),
  proposals: z.array(tripConstraintProposalSchema),
}).strict();

export const createTripConstraintProposalRequestSchema = z.object({
  fieldKey: z.string().min(1).max(64),
  valueJson: z.unknown(),
  proposedVisibility: constraintVisibilitySchema,
  proposedStrength: constraintStrengthSchema,
  sourceKind: constraintProposalSourceKindSchema.optional(),
}).strict();

export const confirmTripConstraintProposalRequestSchema = z.object({
  visibility: constraintVisibilitySchema,
  strength: constraintStrengthSchema,
}).strict();

export const upsertTripConstraintFactRequestSchema = z.object({
  fieldKey: z.string().min(1).max(64),
  valueJson: z.unknown(),
  visibility: constraintVisibilitySchema,
  strength: constraintStrengthSchema,
  expectedRevision: z.number().int().positive().optional(),
}).strict();

export const castAdoptionVoteRequestSchema = z.object({
  decision: planAdoptionDecisionSchema,
}).strict();

export const adoptionVoteResponseSchema = z.object({
  planId: z.string().uuid(),
  outcome: z.enum(["CAST", "ADOPTED", "BLOCKED"]),
  votesAccepted: z.number().int().nonnegative(),
  votesRequired: z.number().int().nonnegative(),
}).strict();

export const planAdoptionVoteSchema = z.object({
  planId: z.string().uuid(),
  userId: z.string().uuid(),
  decision: planAdoptionDecisionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const adoptionVoteListResponseSchema = z.object({
  planId: z.string().uuid(),
  votesAccepted: z.number().int().nonnegative(),
  votesRequired: z.number().int().nonnegative(),
  hasBlocker: z.boolean(),
  currentUserDecision: z.enum(["ACCEPT", "NEEDS_CHANGES"]).nullable(),
}).strict();

export const listedPlanSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
  status: z.enum(["DRAFT", "ACTIVE", "PROPOSED", "STALE", "SUPERSEDED"]),
  snapshotId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  destination: z.string(),
  destinationCandidatesEvaluated: z.array(z.string()),
  replacedByPlanId: z.string().uuid().nullable(),
  staleReason: z.string().nullable(),
  planData: z.record(z.string(), z.unknown()),
}).strict();

export const tripPlansListResponseSchema = z.object({
  tripId: z.string().uuid(),
  proposed: z.array(listedPlanSchema),
  active: z.array(listedPlanSchema),
  stale: z.array(listedPlanSchema),
}).strict();

export const confirmProposalResponseSchema = z.object({
  factId: z.string().uuid(),
  proposalId: z.string().uuid(),
  replan: z.object({
    runId: z.string().uuid(),
    queuedAt: z.string().datetime(),
  }).nullable(),
}).strict();

export const upsertFactResponseSchema = z.object({
  factId: z.string().uuid(),
  replan: z.object({
    runId: z.string().uuid(),
    queuedAt: z.string().datetime(),
  }).nullable(),
}).strict();

export type ConstraintVisibility = z.infer<typeof constraintVisibilitySchema>;
export type ConstraintStrength = z.infer<typeof constraintStrengthSchema>;
export type ConstraintProposalStatus = z.infer<typeof constraintProposalStatusSchema>;
export type PlanAdoptionDecision = z.infer<typeof planAdoptionDecisionSchema>;
export type ConstraintProposalSourceKind = z.infer<typeof constraintProposalSourceKindSchema>;
export type TripConstraintProposal = z.infer<typeof tripConstraintProposalSchema>;
export type TripConstraintFact = z.infer<typeof tripConstraintFactSchema>;
export type TripConstraintsResponse = z.infer<typeof tripConstraintsResponseSchema>;
export type TripConstraintsOwnerResponse = z.infer<typeof tripConstraintsOwnerResponseSchema>;
export type TripConstraintProposalsResponse = z.infer<typeof tripConstraintProposalsResponseSchema>;
export type CreateTripConstraintProposalRequest = z.infer<typeof createTripConstraintProposalRequestSchema>;
export type ConfirmTripConstraintProposalRequest = z.infer<typeof confirmTripConstraintProposalRequestSchema>;
export type UpsertTripConstraintFactRequest = z.infer<typeof upsertTripConstraintFactRequestSchema>;
export type CastAdoptionVoteRequest = z.infer<typeof castAdoptionVoteRequestSchema>;
export type AdoptionVoteResponse = z.infer<typeof adoptionVoteResponseSchema>;
export type PlanAdoptionVote = z.infer<typeof planAdoptionVoteSchema>;
export type AdoptionVoteListResponse = z.infer<typeof adoptionVoteListResponseSchema>;
export type ListedPlan = z.infer<typeof listedPlanSchema>;
export type TripPlansListResponse = z.infer<typeof tripPlansListResponseSchema>;
export type ConfirmProposalResponse = z.infer<typeof confirmProposalResponseSchema>;
export type UpsertFactResponse = z.infer<typeof upsertFactResponseSchema>;

// ─── Global POI & ground mobility (spec docs/ground-mobility-implementation.md §4/§5) ───
// Server-authoritative TripPlace + run-bound place candidate DTOs. The web
// client never sees raw provider coordinates (they are part of TripPlace but
// only reach this client after server-side membership enforcement), and it
// never receives route geometry or booking links.

export const tripPlaceKindSchema = z.enum(["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"]);
export const tripPlaceVisibilitySchema = z.enum(["OWNER_PRIVATE", "TEAM_VISIBLE", "ORCHESTRATOR_CONFIDENTIAL"]);
export const tripPlaceStatusSchema = z.enum(["PROPOSED", "ACTIVE", "REVOKED"]);

export const tripPlaceSchema = z.object({
  id: z.string().uuid(),
  tripId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  version: z.number().int().positive(),
  visibility: tripPlaceVisibilitySchema,
  status: tripPlaceStatusSchema,
  kind: tripPlaceKindSchema,
  displayName: z.string().min(1).max(256),
  countryCode: z.string().length(2).nullable(),
  cityName: z.string().min(1).max(128).nullable(),
  longitude: z.number().finite().min(-180).max(180).nullable(),
  latitude: z.number().finite().min(-90).max(90).nullable(),
  source: z.string().min(1),
  providerPlaceId: z.string().min(1).nullable(),
  capturedAt: z.string().datetime(),
  createdFromRunId: z.string().uuid().nullable(),
}).strict();

export const tripPlacesResponseSchema = z.object({
  tripId: z.string().uuid(),
  places: z.array(tripPlaceSchema),
}).strict();

export const placeCandidateSchema = z.object({
  candidateId: z.string().uuid(),
  displayName: z.string().min(1).max(256),
  kind: tripPlaceKindSchema,
  countryCode: z.string().length(2).nullable(),
  cityName: z.string().min(1).max(128).nullable(),
  longitude: z.number().finite().min(-180).max(180),
  latitude: z.number().finite().min(-90).max(90),
  confidence: z.number().min(0).max(1),
  needsUserConfirmation: z.boolean(),
  source: z.string().min(1),
  capturedAt: z.string().datetime(),
}).strict();

export const placeCandidateSearchRequestSchema = z.object({
  destinationId: z.string().min(1).max(64),
  keyword: z.string().min(1).max(160),
  category: tripPlaceKindSchema,
}).strict();

export const placeCandidateSearchResponseSchema = z.object({
  queryId: z.string().uuid(),
  candidates: z.array(placeCandidateSchema),
}).strict();

export const proposeTripPlaceRequestSchema = z.object({
  candidate: placeCandidateSchema,
  visibility: tripPlaceVisibilitySchema,
  kind: tripPlaceKindSchema,
}).strict();

export const adoptTripPlaceRequestSchema = z.object({
  placeId: z.string().uuid(),
}).strict();

export const revokeTripPlaceRequestSchema = z.object({
  placeId: z.string().uuid(),
  reason: z.string().min(1).max(256),
}).strict();

export const tripPlaceActionResponseSchema = z.object({
  placeId: z.string().uuid(),
  status: tripPlaceStatusSchema,
}).strict();

export const serviceCapabilitySchema = z.enum(["flight", "stay", "hotel", "accommodation", "activities", "navigation", "transit", "mobility"]);
export const providerUnavailableCodeSchema = z.enum([
  "NOT_CONFIGURED",
  "SEARCH_CONSTRAINTS_INCOMPLETE",
  "NO_RESULTS",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
  "INVALID_PROVIDER_RESPONSE",
  "PROVIDER_NOT_APPROVED",
]);

export const serviceGapSchema = z.object({
  capability: serviceCapabilitySchema,
  code: providerUnavailableCodeSchema,
  destinationId: z.string().optional(),
}).strict();

export const researchResultStatusSchema = z.enum(["COMPLETE", "COMPLETED_WITH_GAPS"]);

export const researchResultSchema = z.object({
  id: z.string().uuid(),
  tripId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  agentTaskRunId: z.string().uuid().nullable(),
  status: researchResultStatusSchema,
  serviceGaps: z.array(serviceGapSchema),
  resultPlanId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
}).strict();

export type ServiceCapability = z.infer<typeof serviceCapabilitySchema>;
export type ProviderUnavailableCode = z.infer<typeof providerUnavailableCodeSchema>;
export type ServiceGap = z.infer<typeof serviceGapSchema>;
export type ResearchResultStatus = z.infer<typeof researchResultStatusSchema>;
export type ResearchResult = z.infer<typeof researchResultSchema>;

// Note: `personalResearchCapabilitySchema` / `personalResearchKindSchema` /
// `personalResearchIntentSchema` are declared above the `agentStreamEventSchema`
// discriminated union (so the SSE member can reference them). The remaining
// Phase 6 request/response schemas follow below.

export const researchCommandRequestSchema = z.object({
  requestId: z.string().uuid(),
  outputMode: personalResearchKindSchema,
  requestedCapabilities: z.array(personalResearchCapabilitySchema).min(1),
}).strict();
export type ResearchCommandRequest = z.infer<typeof researchCommandRequestSchema>;

export const researchCommandAcceptedResponseSchema = z.object({
  runId: z.string().uuid(),
  operation: z.enum(["RESEARCH", "PLAN"]),
  snapshotId: z.string().uuid(),
  status: z.literal("QUEUED"),
}).strict();
export type ResearchCommandAcceptedResponse = z.infer<typeof researchCommandAcceptedResponseSchema>;

export const latestResearchResultResponseSchema = z.object({
  result: researchResultSchema.nullable(),
}).strict();
export type LatestResearchResultResponse = z.infer<typeof latestResearchResultResponseSchema>;

export const soloAdoptPlanResponseSchema = z.object({
  planId: z.string().uuid(),
  status: z.literal("ACTIVE"),
}).strict();
export type SoloAdoptPlanResponse = z.infer<typeof soloAdoptPlanResponseSchema>;

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
export type ResearchStage = z.infer<typeof researchStageSchema>;

const streamBaseShape = {
  runId: z.string().uuid(),
  generationAttempt: z.number().int().nonnegative(),
  traceparent: z.string().optional(),
};
export const researchStageEventSchema = z.object({
  ...streamBaseShape,
  event: z.literal("research.stage"),
  stage: researchStageSchema,
}).strict();
export type ResearchStageEvent = z.infer<typeof researchStageEventSchema>;

export const researchIntentExtractedEventSchema = z.object({
  ...streamBaseShape,
  event: z.literal("research.intent_extracted"),
  intent: personalResearchIntentSchema,
}).strict();
export type ResearchIntentExtractedEvent = z.infer<typeof researchIntentExtractedEventSchema>;

// ─── Navigation route evidence (spec §5.2) ─────────────────────────────────
// Server-authoritative route snapshot. The geometry is bound to the
// `snapshotId` and only reaches the browser via the snapshot-bound DTO; the
// raw polyline is never shipped to a third party.
export const navigationRouteModeSchema = z.enum(["WALK", "DRIVE", "CYCLE"]);

export const navigationRouteStepSchema = z.object({
  index: z.number().int().nonnegative(),
  instruction: z.string().min(1).max(512),
  distanceMeters: z.number().nonnegative(),
  durationSeconds: z.number().nonnegative(),
}).strict();

export const routeEvidenceSchema = z.object({
  id: z.string().uuid(),
  searchRunId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  tripId: z.string().uuid(),
  originPlaceId: z.string().uuid(),
  destinationPlaceId: z.string().uuid(),
  mode: navigationRouteModeSchema,
  distanceMeters: z.number().nonnegative().finite(),
  durationSeconds: z.number().nonnegative().finite(),
  steps: z.array(navigationRouteStepSchema).max(64),
  source: z.string().min(1),
  capturedAt: z.string().datetime(),
  refreshAfter: z.string().datetime(),
}).strict();

export const routeEvidenceListSchema = z.object({
  tripId: z.string().uuid(),
  routes: z.array(routeEvidenceSchema),
}).strict();

export const navigationRouteSearchRequestSchema = z.object({
  originPlaceId: z.string().uuid(),
  destinationPlaceId: z.string().uuid(),
  mode: navigationRouteModeSchema,
}).strict();

export const navigationRouteSearchResponseSchema = z.object({
  routeId: z.string().uuid(),
  summary: routeEvidenceSchema.omit({ id: true, searchRunId: true, snapshotId: true, tripId: true, steps: true, refreshAfter: true }).extend({
    stepCount: z.number().int().nonnegative(),
  }),
}).strict();

export type NavigationRouteMode = z.infer<typeof navigationRouteModeSchema>;
export type NavigationRouteStep = z.infer<typeof navigationRouteStepSchema>;
export type RouteEvidence = z.infer<typeof routeEvidenceSchema>;
export type RouteEvidenceList = z.infer<typeof routeEvidenceListSchema>;
export type NavigationRouteSearchRequest = z.infer<typeof navigationRouteSearchRequestSchema>;
export type NavigationRouteSearchResponse = z.infer<typeof navigationRouteSearchResponseSchema>;

export const mobilityServiceTypeSchema = z.enum(["TAXI", "TRANSFER", "CHARTER", "RENTAL"]);

export const mobilityOfferSchema = z.object({
  offerId: z.string().min(1),
  serviceType: mobilityServiceTypeSchema,
  originPlaceId: z.string().uuid(),
  destinationPlaceId: z.string().uuid(),
  passengers: z.number().int().min(1).max(9),
  departureAt: z.string().datetime({ offset: true }),
  estimatedPrice: z.number().nonnegative().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  vehicleClass: z.string().min(1).max(64),
  estimated: z.literal(true),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  source: z.string().min(1),
  capturedAt: z.string().datetime({ offset: true }),
}).strict();

export const mobilityOfferListSchema = z.object({
  tripId: z.string().uuid(),
  offers: z.array(mobilityOfferSchema),
}).strict();

export const mobilitySearchRequestSchema = z.object({
  originPlaceId: z.string().uuid(),
  destinationPlaceId: z.string().uuid(),
  passengers: z.number().int().min(1).max(9),
  departureAt: z.string().datetime({ offset: true }),
  serviceType: mobilityServiceTypeSchema,
}).strict();

export const mobilitySearchResponseSchema = z.object({
  queryId: z.string().uuid(),
  offers: z.array(mobilityOfferSchema).min(1).max(20),
}).strict();

export const mobilityOfferSelectionRequestSchema = z.object({
  offerId: z.string().min(1),
  queryId: z.string().uuid(),
}).strict();

export const mobilityOfferSelectionResponseSchema = z.object({
  selectedOfferId: z.string().min(1),
  bookingGate: z.enum(["OPEN", "CLOSED"]),
}).strict();

export type MobilityServiceType = z.infer<typeof mobilityServiceTypeSchema>;
export type MobilityOffer = z.infer<typeof mobilityOfferSchema>;
export type MobilityOfferList = z.infer<typeof mobilityOfferListSchema>;
export type MobilitySearchRequest = z.infer<typeof mobilitySearchRequestSchema>;
export type MobilitySearchResponse = z.infer<typeof mobilitySearchResponseSchema>;
export type MobilityOfferSelectionRequest = z.infer<typeof mobilityOfferSelectionRequestSchema>;
export type MobilityOfferSelectionResponse = z.infer<typeof mobilityOfferSelectionResponseSchema>;

export type TripPlaceKind = z.infer<typeof tripPlaceKindSchema>;
export type TripPlaceVisibility = z.infer<typeof tripPlaceVisibilitySchema>;
export type TripPlaceStatus = z.infer<typeof tripPlaceStatusSchema>;
export type TripPlace = z.infer<typeof tripPlaceSchema>;
export type TripPlacesResponse = z.infer<typeof tripPlacesResponseSchema>;
export type PlaceCandidate = z.infer<typeof placeCandidateSchema>;
export type PlaceCandidateSearchRequest = z.infer<typeof placeCandidateSearchRequestSchema>;
export type PlaceCandidateSearchResponse = z.infer<typeof placeCandidateSearchResponseSchema>;
export type ProposeTripPlaceRequest = z.infer<typeof proposeTripPlaceRequestSchema>;
export type AdoptTripPlaceRequest = z.infer<typeof adoptTripPlaceRequestSchema>;
export type RevokeTripPlaceRequest = z.infer<typeof revokeTripPlaceRequestSchema>;
export type TripPlaceActionResponse = z.infer<typeof tripPlaceActionResponseSchema>;
