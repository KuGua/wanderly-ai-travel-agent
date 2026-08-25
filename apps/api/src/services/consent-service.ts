import { db } from "../db/database.js";
import { consentGrants, userProfiles, itineraryPlans, memberConfirmations } from "../db/schema.js";
import { eq, and, inArray } from "drizzle-orm";
import { recordAudit } from "./audit-service.js";
import type { ConsentScope } from "../types/domain.js";
import type { RequestContext } from "../utils/context.js";

/**
 * Grant consent for a specific scope within a trip.
 *
 * The grant (or revoke) and the cascading staleness of every plan +
 * confirmation that depends on this trip's consent are committed in one
 * transaction so a failure cannot leave plans referencing a stale grant.
 */
export async function grantConsent(params: {
  ctx: RequestContext;
  tripId: string;
  userId: string;
  scope: ConsentScope;
  fieldList: string[];
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(consentGrants)
      .set({ granted: false, revokedAt: new Date() })
      .where(and(
        eq(consentGrants.tripId, params.tripId),
        eq(consentGrants.userId, params.userId),
        eq(consentGrants.scope, params.scope),
      ));

    await tx.insert(consentGrants).values({
      tripId: params.tripId,
      userId: params.userId,
      scope: params.scope,
      fieldList: params.fieldList,
      granted: true,
    });

    await stalePlansAndConfirmationsForTrip(tx, {
      tripId: params.tripId,
      reason: `consent_granted:${params.scope}`,
    });

    await recordAudit({
      ctx: params.ctx,
      action: "CONSENT_GRANT",
      actorUserId: params.userId,
      tripId: params.tripId,
      summary: { scope: params.scope, fieldCount: params.fieldList.length },
      tx,
    });
  });
}

/**
 * Revoke consent for a specific scope within a trip. Cascades staleness to
 * every active plan that referenced this trip's grant snapshot.
 */
export async function revokeConsent(params: {
  ctx: RequestContext;
  tripId: string;
  userId: string;
  scope: ConsentScope;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(consentGrants)
      .set({ granted: false, revokedAt: new Date() })
      .where(and(
        eq(consentGrants.tripId, params.tripId),
        eq(consentGrants.userId, params.userId),
        eq(consentGrants.scope, params.scope),
        eq(consentGrants.granted, true),
      ));

    await stalePlansAndConfirmationsForTrip(tx, {
      tripId: params.tripId,
      reason: `consent_revoked:${params.scope}`,
    });

    await recordAudit({
      ctx: params.ctx,
      action: "CONSENT_REVOKE",
      actorUserId: params.userId,
      tripId: params.tripId,
      summary: { scope: params.scope },
      tx,
    });
  });
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
      if (field in p && p[field as keyof typeof p] !== null && p[field as keyof typeof p] !== undefined) {
        if (field === "passportNumber") continue;
        authorized[field] = p[field as keyof typeof p];
      }
    }
  }

  return authorized;
}

/**
 * Mark every ACTIVE plan for a trip as STALE (and SUPERSEDED so the next
 * generation starts a fresh version) along with every dependent member
 * confirmation. Used both by consent grant/revoke and by change events.
 *
 * Must be invoked inside a `db.transaction` so the cascade commits
 * atomically with the originating change.
 */
export async function stalePlansAndConfirmationsForTrip(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  params: { tripId: string; reason: string },
): Promise<{ stalePlanIds: string[] }> {
  const activePlans = await tx.select({ id: itineraryPlans.id })
    .from(itineraryPlans)
    .where(and(
      eq(itineraryPlans.tripId, params.tripId),
      eq(itineraryPlans.status, "ACTIVE"),
    ));

  if (activePlans.length === 0) {
    return { stalePlanIds: [] };
  }

  const stalePlanIds = activePlans.map(p => p.id);

  await tx.update(itineraryPlans)
    .set({
      status: "STALE",
      staleReason: params.reason,
      supersededAt: new Date(),
    })
    .where(inArray(itineraryPlans.id, stalePlanIds));

  await tx.update(memberConfirmations)
    .set({ status: "STALE" })
    .where(inArray(memberConfirmations.planId, stalePlanIds));

  return { stalePlanIds };
}
