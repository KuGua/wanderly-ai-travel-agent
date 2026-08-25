import {
  profileResponseSchema,
} from "@/lib/api/contracts";

export const fixtureProfile = profileResponseSchema.parse({
    profile: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      userId: "11111111-1111-4111-8111-111111111111",
      displayName: "旅行者",
      nationality: "US",
      dateOfBirth: null,
      interests: ["艺术", "博物馆", "当地美食"],
      accommodationStyle: "city_center",
      budgetMaxUsd: 5000,
      noRedEye: true,
      mobilityNotes: null,
      availableDepartureDates: ["2026-10-03", "2026-10-10"],
      departureCity: "旧金山",
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
    },
  });