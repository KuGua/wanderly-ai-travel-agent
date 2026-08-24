import {
  profileResponseSchema,
} from "@/lib/api/contracts";

export const fixtureProfile = profileResponseSchema.parse({
    profile: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "11111111-1111-4111-8111-111111111111",
      displayName: "Traveler",
      nationality: "US",
      dateOfBirth: null,
      interests: ["art", "museums", "local food"],
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
