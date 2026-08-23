import { db } from "../db/database.js";
import { consentGrants, userProfiles } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import type { ConsentScope } from "../types/domain.js";

/**
 * Grant consent for a specific scope and field list within a trip.
 */
export async function grantConsent(params: {
  tripId: string;
  userId: string;
  scope: ConsentScope;
  fieldList: string[];
}): Promise<void> {
  // Upsert: revoke any existing grant for this scope, then insert new
  await db.update(consentGrants)
    .set({ granted: false, revokedAt: new Date() })
    .where(and(
      eq(consentGrants.tripId, params.tripId),
      eq(consentGrants.userId, params.userId),
      eq(consentGrants.scope, params.scope),
    ));

  await db.insert(consentGrants).values({
    tripId: params.tripId,
    userId: params.userId,
    scope: params.scope,
    fieldList: params.fieldList,
    granted: true,
  });
}

/**
 * Revoke consent for a specific scope within a trip.
 */
export async function revokeConsent(params: {
  tripId: string;
  userId: string;
  scope: ConsentScope;
}): Promise<void> {
  await db.update(consentGrants)
    .set({ granted: false, revokedAt: new Date() })
    .where(and(
      eq(consentGrants.tripId, params.tripId),
      eq(consentGrants.userId, params.userId),
      eq(consentGrants.scope, params.scope),
      eq(consentGrants.granted, true),
    ));
}

/**
 * Get all active consent grants for a user within a trip.
 */
export async function getActiveConsents(params: {
  tripId: string;
  userId: string;
}): Promise<Array<{ scope: ConsentScope; fieldList: string[] }>> {
  const grants = await db.select().from(consentGrants)
    .where(and(
      eq(consentGrants.tripId, params.tripId),
      eq(consentGrants.userId, params.userId),
      eq(consentGrants.granted, true),
    ));

  return grants.map(g => ({
    scope: g.scope as ConsentScope,
    fieldList: g.fieldList ?? [],
  }));
}

/**
 * Build authorized data snapshot for a user based on active consents.
 * Only includes fields explicitly granted.
 */
export async function buildAuthorizedData(params: {
  tripId: string;
  userId: string;
}): Promise<Record<string, unknown>> {
  const consents = await getActiveConsents(params);
  const profile = await db.select().from(userProfiles)
    .where(eq(userProfiles.userId, params.userId))
    .limit(1);

  if (profile.length === 0) return {};

  const p = profile[0];
  const authorized: Record<string, unknown> = {};

  for (const consent of consents) {
    for (const field of consent.fieldList) {
      // Only include fields that exist in the profile
      if (field in p && p[field as keyof typeof p] !== null && p[field as keyof typeof p] !== undefined) {
        // Never include passportNumber in authorized data (sensitive)
        if (field === "passportNumber") continue;
        authorized[field] = p[field as keyof typeof p];
      }
    }
  }

  return authorized;
}
