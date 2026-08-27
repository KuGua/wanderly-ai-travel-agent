import { randomUUID } from "node:crypto";

import { db } from "../../src/db/database.js";
import { sharedTrips, tripMembers } from "../../src/db/schema.js";

/**
 * Provision a Trip + member row for the given owner.  Many legacy
 * tests previously inserted chat threads without a Trip binding;
 * since `chat_threads.trip_id` is NOT NULL post-migration 0012, every
 * thread insert must first have a Trip + membership row.  This helper
 * returns both ids so tests can wire them up in one shot.
 */
export async function provisionTripAndMember(params: {
  ownerUserId: string;
  destinationCount?: number;
}): Promise<{ tripId: string; memberUserId: string }> {
  const tripId = randomUUID();
  await db.insert(sharedTrips).values({
    id: tripId,
    name: `Trip ${tripId.slice(0, 8)}`,
    createdBy: params.ownerUserId,
    departureCities: ["San Francisco"],
    destinationCandidates: Array.from({ length: params.destinationCount ?? 2 }, (_, i) => `City ${i + 1}`),
  });
  await db.insert(tripMembers).values({
    tripId,
    userId: params.ownerUserId,
    role: "CREATOR",
    isRequired: true,
  });
  return { tripId, memberUserId: params.ownerUserId };
}
