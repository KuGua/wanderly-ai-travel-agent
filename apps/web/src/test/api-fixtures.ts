import { profileResponseSchema, tripsResponseSchema } from "@/lib/api/contracts";

/** Test-only API-shaped values. They are never imported by product code. */
export const testProfileResponse = profileResponseSchema.parse({
  profile: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "11111111-1111-4111-8111-111111111111",
    displayName: "Test traveler",
    nationality: "US",
    dateOfBirth: null,
    interests: ["art", "museums"],
    accommodationStyle: "city_center",
    budgetMaxUsd: 5000,
    noRedEye: true,
    mobilityNotes: null,
    availableDepartureDates: ["2026-10-03", "2026-10-10"],
    departureCity: "San Francisco",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  },
});

export const testTripsResponse = tripsResponseSchema.parse({ trips: [] });
