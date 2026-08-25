import { eq, and } from "drizzle-orm";
import { db } from "../db/database.js";
import { visaReadinessChecks, consentGrants, constraintSnapshots } from "../db/schema.js";
import { FixtureVisaProvider } from "../providers/fixture-provider.js";
import type { VisaReadinessResult } from "../types/domain.js";

const visaProvider = new FixtureVisaProvider();

/**
 * Generate visa readiness check for a member.
 *
 * Source of truth for `nationality` is `constraint_snapshots.authorizedData`
 * — never an inferred or hard-coded value. If the member did not authorize
 * `PROFILE_NATIONALITY` for this trip, the function returns the
 * `UNAUTHORIZED_NO_CHECK` branch without consulting the provider.
 */
export async function checkVisaReadiness(params: {
  planId: string;
  snapshotId: string;
  memberId: string;
  tripId: string;
  destinationCountry: string;
}): Promise<VisaReadinessResult> {
  const nationalityConsent = await db.select().from(consentGrants)
    .where(and(
      eq(consentGrants.tripId, params.tripId),
      eq(consentGrants.userId, params.memberId),
      eq(consentGrants.scope, "PROFILE_NATIONALITY"),
      eq(consentGrants.granted, true),
    ))
    .limit(1);

  if (nationalityConsent.length === 0) {
    const result: VisaReadinessResult = {
      memberId: params.memberId,
      destinationCountry: params.destinationCountry,
      status: "UNAUTHORIZED_NO_CHECK",
      checklist: [
        {
          item: "Visa requirements cannot be determined — nationality not authorized for sharing",
          source: "System",
          uncertainty: "User must verify visa requirements with official government sources based on their nationality",
        },
      ],
      confidenceLevel: "UNCERTAIN",
      source: "System — no consent for nationality",
      capturedAt: new Date().toISOString(),
      disclaimer: "Nationality was not shared. Please verify visa requirements with official government sources.",
    };

    await db.insert(visaReadinessChecks).values({
      planId: params.planId,
      snapshotId: params.snapshotId,
      memberId: params.memberId,
      destinationCountry: params.destinationCountry,
      status: "UNAUTHORIZED_NO_CHECK",
      checklist: result.checklist,
      confidenceLevel: "UNCERTAIN",
      source: "System — no consent for nationality",
      disclaimer: result.disclaimer,
    });

    return result;
  }

  const nationality = await readNationalityFromSnapshot({
    snapshotId: params.snapshotId,
    memberId: params.memberId,
  });

  if (!nationality) {
    const result: VisaReadinessResult = {
      memberId: params.memberId,
      destinationCountry: params.destinationCountry,
      status: "UNAUTHORIZED_NO_CHECK",
      checklist: [
        {
          item: "Visa requirements cannot be determined — nationality missing from snapshot authorized data",
          source: "System",
          uncertainty: "Snapshot was built without a usable nationality value; user must re-authorize and regenerate the snapshot",
        },
      ],
      confidenceLevel: "UNCERTAIN",
      source: "System — snapshot missing nationality",
      capturedAt: new Date().toISOString(),
      disclaimer: "Nationality is authorized but missing from the current snapshot. Re-authorize and regenerate the plan.",
    };

    await db.insert(visaReadinessChecks).values({
      planId: params.planId,
      snapshotId: params.snapshotId,
      memberId: params.memberId,
      destinationCountry: params.destinationCountry,
      status: "UNAUTHORIZED_NO_CHECK",
      checklist: result.checklist,
      confidenceLevel: "UNCERTAIN",
      source: "System — snapshot missing nationality",
      disclaimer: result.disclaimer,
    });

    return result;
  }

  const providerResult = await visaProvider.checkReadiness({
    nationality,
    destinationCountry: params.destinationCountry,
    snapshotId: params.snapshotId,
  });

  const result: VisaReadinessResult = providerResult.outcome === "UNAVAILABLE"
    ? {
        memberId: params.memberId,
        destinationCountry: params.destinationCountry,
        nationality,
        status: "AUTHORIZED_CHECK",
        checklist: [{
          item: "Visa requirements unavailable for this nationality and destination",
          source: "System",
          uncertainty: "No fixture data is available; verify with official government sources",
        }],
        confidenceLevel: "UNCERTAIN",
        source: "System — provider unavailable",
        capturedAt: new Date().toISOString(),
        disclaimer: "No provider result is available. Verify all requirements with official government sources.",
      }
    : { ...providerResult.data, nationality };

  result.memberId = params.memberId;
  result.disclaimer = (result.disclaimer ?? "")
    + " Nationality sourced from snapshot authorizedData.";

  await db.insert(visaReadinessChecks).values({
    planId: params.planId,
    snapshotId: params.snapshotId,
    memberId: params.memberId,
    destinationCountry: params.destinationCountry,
    nationality,
    status: "AUTHORIZED_CHECK",
    checklist: result.checklist,
    confidenceLevel: result.confidenceLevel,
    source: result.source,
    disclaimer: result.disclaimer,
  });

  return result;
}

/**
 * Read the authorized nationality for a member from the immutable snapshot.
 * Returns `null` if the snapshot is missing, the member has no entry, or
 * the entry does not contain a usable `nationality` string.
 */
async function readNationalityFromSnapshot(params: {
  snapshotId: string;
  memberId: string;
}): Promise<string | null> {
  const [snap] = await db.select({ auth: constraintSnapshots.authorizedData })
    .from(constraintSnapshots)
    .where(eq(constraintSnapshots.id, params.snapshotId))
    .limit(1);

  if (!snap) return null;
  const memberEntry = (snap.auth as Record<string, Record<string, unknown>> | null)?.[params.memberId];
  if (!memberEntry) return null;
  const value = memberEntry.nationality;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
