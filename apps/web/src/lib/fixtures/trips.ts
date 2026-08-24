import {
  tripsResponseSchema,
} from "@/lib/api/contracts";

const asiaTrip = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Asia Trip",
  status: "PLANNING",
  departureCities: ["San Francisco", "Shanghai"],
  destinationCandidates: ["Tokyo", "Bangkok", "Seoul"],
  travelDateStart: "2026-10-03",
  travelDateEnd: "2026-10-10",
  memberCount: 3,
  createdAt: "2026-08-24T10:20:00.000Z",
} as const;

export const fixtureTrips = tripsResponseSchema.parse({
  trips: [{ ...asiaTrip, role: "CREATOR" }],
});
