import { and, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { destinationCandidates } from "../db/schema.js";
import { getLocationReferenceResolver } from "../location-reference/location-reference-resolver.js";
import type { DestinationReference } from "../types/domain.js";

type DestinationReferenceDb = Pick<typeof db, "select">;

/**
 * Resolve only a server-owned destination candidate. Missing, duplicated or
 * geographically ambiguous records fail closed; provider callers must never
 * fall back to the model/browser label.
 */
export async function resolveTripDestinationReference(params: {
  tripId: string;
  destinationId: string;
  client?: DestinationReferenceDb;
}): Promise<DestinationReference | null> {
  const rows = await (params.client ?? db).select({
    city: destinationCandidates.city,
    country: destinationCandidates.country,
  }).from(destinationCandidates).where(and(
    eq(destinationCandidates.tripId, params.tripId),
    eq(destinationCandidates.city, params.destinationId),
  )).limit(2);
  if (rows.length > 1) return null;
  const candidate = rows[0];
  return getLocationReferenceResolver().resolveDestinationReference({
    destinationId: params.destinationId,
    cityName: candidate?.city ?? params.destinationId,
    countryHint: candidate?.country ?? null,
  });
}
