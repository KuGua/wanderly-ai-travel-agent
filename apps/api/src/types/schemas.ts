import { z } from "zod";

// ─── Common ─────────────────────────────────────────────────────────────────

export const uuidSchema = z.string().uuid();
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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
});

export const tripsResponseSchema = z.object({
  trips: z.array(tripSummarySchema),
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

// ─── Demo Identity ─────────────────────────────────────────────────────────

export const demoUserSchema = z.object({
  id: uuidSchema,
  externalId: z.enum(["alice", "bob", "chen"]),
  displayName: z.string(),
});

export const demoUsersResponseSchema = z.object({
  users: z.array(demoUserSchema),
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

export type DemoUser = z.infer<typeof demoUserSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type TripSummary = z.infer<typeof tripSummarySchema>;
export type TripsResponse = z.infer<typeof tripsResponseSchema>;
export type ApiErrorResponse = z.infer<typeof errorResponseSchema>;
