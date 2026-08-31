/**
 * Personal Research Readiness Service — Phase 0/1.
 *
 * Pure read against server-owned Trip / preferences / authorization / places
 * state. Decides whether a `PersistedResearchIntentDraft` is READY for owner
 * confirmation, NEEDS_SETUP (some Trip configuration missing), or
 * NEEDS_PLACE_SELECTION (route endpoints not yet adopted).
 *
 * The service does NOT mutate the draft, does NOT publish SSE, and does NOT
 * call any provider. Its only side effects are read-only DB queries that
 * mirror the gates enforced at `POST /trips/:tripId/research` acceptance
 * time. Spec §5.2.
 *
 * Source: docs/personal-research-intent-routing-implementation.md §5.2.
 */

import { and, desc, eq, ne } from "drizzle-orm";

import { db } from "../db/database.js";
import {
  sharedTrips,
  researchRouteSelections,
  tripPlaces,
  tripSearchPreferences,
  tripStaySearchPreferences,
} from "../db/schema.js";
import { resolvePersistedHotelProviderName } from "../providers/live-provider-factory.js";
import { requireResearchEligible } from "./trip-status-guard.js";
import { loadActiveQuoteNationality } from "./stay-search-provider-authorization.js";

// ─── Mirror types (avoid upstream cycles) ───────────────────────────────────

export type ResearchCapability =
  | "flight"
  | "accommodation"
  | "hotel"
  | "activities"
  | "places"
  | "navigation"
  | "mobility"
  | "readiness";

export type ResearchMissingCode =
  | "TRIP_NOT_ACTIVE"
  | "DESTINATION_NOT_CONFIGURED"
  | "DATES_MISSING"
  | "FLIGHT_PREFERENCES_MISSING"
  | "STAY_PREFERENCES_MISSING"
  | "HOTEL_PROVIDER_NOT_APPROVED"
  | "QUOTE_NATIONALITY_AUTHORIZATION_MISSING"
  | "ROUTE_ENDPOINTS_UNCONFIRMED"
  | "MODE_NOT_CHOSEN";

export type ResearchReadiness = "READY" | "NEEDS_SETUP" | "NEEDS_PLACE_SELECTION";

export interface EvaluateReadinessInput {
  tripId: string;
  ownerUserId: string;
  /** Required for navigation/mobility drafts: selection is owned by this intent run. */
  intentRunId?: string;
  requestedCapabilities: ResearchCapability[];
}

export interface EvaluateReadinessResult {
  readiness: ResearchReadiness;
  missing: ResearchMissingCode[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Statuses where research is acceptable. `STALE` mirrors the existing
 *  orchestrator behavior — research is allowed, but the resulting plan
 *  will be marked STALE downstream. */
const TRIP_RESEARCH_ELIGIBLE_STATUSES = new Set(["PLANNING", "STALE"]);

function uniqueMissing(codes: ResearchMissingCode[]): ResearchMissingCode[] {
  return Array.from(new Set(codes));
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function evaluateReadiness(
  input: EvaluateReadinessInput,
): Promise<EvaluateReadinessResult> {
  // Trip row — used for status, destination, and dates.
  const [trip] = await db.select().from(sharedTrips)
    .where(eq(sharedTrips.id, input.tripId)).limit(1);
  if (!trip) {
    return { readiness: "NEEDS_SETUP", missing: ["TRIP_NOT_ACTIVE"] };
  }

  // Cheap config checks FIRST so we can return specific gap codes
  // (DESTINATION_NOT_CONFIGURED, DATES_MISSING) before the trip-status
  // guard short-circuits on a missing destination.
  if (trip.destinationCandidates.length === 0) {
    return { readiness: "NEEDS_SETUP", missing: ["DESTINATION_NOT_CONFIGURED"] };
  }
  if (!trip.travelDateStart || !trip.travelDateEnd) {
    return { readiness: "NEEDS_SETUP", missing: ["DATES_MISSING"] };
  }

  // Membership check via the canonical guard. Throws ApiError(403) for
  // non-members, ApiError(409) for STALE/DRAFT trip gates. We swallow both
  // and downgrade to TRIP_NOT_ACTIVE so the draft never advertises a
  // readiness the owner cannot actually exercise.
  try {
    await requireResearchEligible(
      input.tripId,
      input.ownerUserId,
      trip.destinationCandidates,
    );
  } catch {
    return { readiness: "NEEDS_SETUP", missing: ["TRIP_NOT_ACTIVE"] };
  }

  if (!TRIP_RESEARCH_ELIGIBLE_STATUSES.has(trip.status)) {
    return { readiness: "NEEDS_SETUP", missing: ["TRIP_NOT_ACTIVE"] };
  }

  const missing = new Set<ResearchMissingCode>();

  // ─── Capability-specific gates ────────────────────────────────────────────
  const needs = new Set(input.requestedCapabilities);

  if (needs.has("flight") || needs.has("activities") || needs.has("mobility")) {
    const [latestFlightPref] = await db.select().from(tripSearchPreferences)
      .where(eq(tripSearchPreferences.tripId, input.tripId))
      .orderBy(desc(tripSearchPreferences.version)).limit(1);
    if (!latestFlightPref) {
      missing.add("FLIGHT_PREFERENCES_MISSING");
    }
  }

  if (needs.has("hotel")) {
    const providerEnabled = process.env.PLAN_ENABLE_HOTEL === "true";
    if (!providerEnabled) {
      missing.add("HOTEL_PROVIDER_NOT_APPROVED");
    } else {
      const [latestStayPref] = await db.select().from(tripStaySearchPreferences)
        .where(eq(tripStaySearchPreferences.tripId, input.tripId))
        .orderBy(desc(tripStaySearchPreferences.version)).limit(1);
      if (!latestStayPref) {
        missing.add("STAY_PREFERENCES_MISSING");
      }
      const boundProvider = resolvePersistedHotelProviderName();
      if (boundProvider === "nuitee_connect") {
        const authorization = await loadActiveQuoteNationality({
          tripId: input.tripId,
          memberId: input.ownerUserId,
        });
        if (!authorization) {
          missing.add("QUOTE_NATIONALITY_AUTHORIZATION_MISSING");
        }
      }
    }
  }

  if (needs.has("navigation") || needs.has("mobility")) {
    const [selection] = input.intentRunId ? await db.select().from(researchRouteSelections).where(and(
      eq(researchRouteSelections.intentRunId, input.intentRunId),
      eq(researchRouteSelections.tripId, input.tripId),
      eq(researchRouteSelections.ownerUserId, input.ownerUserId),
    )).limit(1) : [undefined];
    if (input.intentRunId && !selection) {
      return { readiness: "NEEDS_PLACE_SELECTION", missing: ["ROUTE_ENDPOINTS_UNCONFIRMED", "MODE_NOT_CHOSEN"] };
    }
    const places = await db.select({ id: tripPlaces.id }).from(tripPlaces).where(and(
      eq(tripPlaces.tripId, input.tripId),
      eq(tripPlaces.status, "ACTIVE"),
      ne(tripPlaces.visibility, "OWNER_PRIVATE"),
    ));
    const activeIds = new Set(places.map((place) => place.id));
    if (selection && (!activeIds.has(selection.originPlaceId) || !activeIds.has(selection.destinationPlaceId))) {
      return { readiness: "NEEDS_PLACE_SELECTION", missing: ["ROUTE_ENDPOINTS_UNCONFIRMED"] };
    }
    if (!selection && activeIds.size < 2) return { readiness: "NEEDS_PLACE_SELECTION", missing: ["ROUTE_ENDPOINTS_UNCONFIRMED"] };
  }

  // ─── Default collapse ─────────────────────────────────────────────────────
  // If we collected any setup-style gaps (excluding the place-selection
  // path above which already returned), expose them as NEEDS_SETUP. A READY
  // result MUST carry an empty missing set — invariant tested in
  // personal-research-readiness-service.test.ts.
  if (missing.size === 0) {
    return { readiness: "READY", missing: [] };
  }
  return { readiness: "NEEDS_SETUP", missing: uniqueMissing(Array.from(missing)) };
}
