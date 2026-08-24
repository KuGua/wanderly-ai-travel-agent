import { db } from "../db/database.js";
import { visaReadinessChecks, consentGrants } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { FixtureVisaProvider } from "../providers/fixture-provider.js";
import type { VisaReadinessResult } from "../types/domain.js";

const visaProvider = new FixtureVisaProvider();

/**
 * Generate visa readiness check for a member.
 * If nationality is not authorized via consent, returns UNAUTHORIZED_NO_CHECK.
 */
export async function checkVisaReadiness(params: {
  planId: string;
  snapshotId: string;
  memberId: string;
  tripId: string;
  destinationCountry: string;
}): Promise<VisaReadinessResult> {
  // Check if nationality is authorized via consent
  const nationalityConsent = await db.select().from(consentGrants)
    .where(and(
      eq(consentGrants.tripId, params.tripId),
      eq(consentGrants.userId, params.memberId),
      eq(consentGrants.scope, "PROFILE_NATIONALITY"),
      eq(consentGrants.granted, true),
    ))
    .limit(1);

  if (nationalityConsent.length === 0) {
    // Nationality not authorized — cannot check visa
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

    // Record check
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

  // Nationality is authorized — get it from the snapshot's authorized data
  // For demo, we'll use a simplified lookup
  // In production, fetch from constraintSnapshots.authorizedData[memberId].nationality
  const nationality = "US"; // Simplified — would come from snapshot

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
    : providerResult.data;

  result.memberId = params.memberId;

  // Record check
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
