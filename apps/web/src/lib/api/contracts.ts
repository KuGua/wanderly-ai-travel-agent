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

export const apiErrorResponseSchema = z.object({
  statusCode: z.number(),
  error: z.string(),
  message: z.string(),
  correlationId: z.string().uuid(),
});

export type Profile = z.infer<typeof profileSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;
export type UpdateProfileResponse = z.infer<typeof updateProfileResponseSchema>;
export type TripSummary = z.infer<typeof tripSummarySchema>;
export type TripsResponse = z.infer<typeof tripsResponseSchema>;
