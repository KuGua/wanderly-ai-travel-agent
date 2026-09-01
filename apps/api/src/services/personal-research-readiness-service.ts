/**
 * Personal Research Readiness Service — Phase 0/1/2.
 *
 * Two-tier readiness model: hard blockers (must resolve before research can
 * start) vs soft warnings (research can start, but quality may degrade). The
 * `categorize()` function is the single source of truth for severity; tests
 * and the conversational setup path both reuse it.
 *
 * Per the product intent documented in §5.2, all Trip statuses
 * (DRAFT/PLANNING/STALE/CONFIRMED/BOOKED/CANCELED) are research-eligible.
 * A non-active status (DRAFT/STALE/CANCELED) surfaces a `TRIP_NOT_ACTIVE`
 * advisory in the warnings array; an active status does not. Collaboration
 * commands (planning, consent, booking, …) remain gated separately by
 * `requireActiveTrip` in trip-status-guard.ts.
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

export type ResearchReadiness =
  | "READY"
  | "READY_WITH_WARNINGS"
  | "NEEDS_SETUP"
  | "NEEDS_PLACE_SELECTION";

/** Severity classification for a missing-code. Single source of truth. */
export type ResearchMissingSeverity = "blocker" | "warning";

/**
 * Maps a missing-code to its severity. Blockers must be resolved before
 * research can start; warnings are advisory and the owner can proceed past
 * them via the confirm flow.
 *
 * The split is intentionally narrow: only three codes (`TRIP_NOT_ACTIVE`,
 * `FLIGHT_PREFERENCES_MISSING`, `STAY_PREFERENCES_MISSING`) are soft —
 * every other code describes a hard precondition the provider actually
 * needs to run a query.
 */
export function categorize(code: ResearchMissingCode): ResearchMissingSeverity {
  switch (code) {
    case "TRIP_NOT_ACTIVE":
    case "FLIGHT_PREFERENCES_MISSING":
    case "STAY_PREFERENCES_MISSING":
      return "warning";
    case "DESTINATION_NOT_CONFIGURED":
    case "DATES_MISSING":
    case "HOTEL_PROVIDER_NOT_APPROVED":
    case "QUOTE_NATIONALITY_AUTHORIZATION_MISSING":
    case "ROUTE_ENDPOINTS_UNCONFIRMED":
    case "MODE_NOT_CHOSEN":
      return "blocker";
  }
}

/** Statuses that surface the `TRIP_NOT_ACTIVE` advisory. Anything outside
 *  this set is considered "active enough" to not warn the owner. */
const TRIP_STATUSES_WITH_ADVISORY = new Set<string>([
  "DRAFT",
  "STALE",
  "CANCELLED",
]);

export interface EvaluateReadinessInput {
  tripId: string;
  ownerUserId: string;
  /** Required for navigation/mobility drafts: selection is owned by this intent run. */
  intentRunId?: string;
  requestedCapabilities: ResearchCapability[];
}

export interface EvaluateReadinessResult {
  readiness: ResearchReadiness;
  /** Hard blockers — research cannot start until these are resolved. */
  blockers: ResearchMissingCode[];
  /** Soft warnings — research can start, but quality may degrade. */
  warnings: ResearchMissingCode[];
  /** Union of `blockers ∪ warnings`, retained for backward compatibility with
   *  older clients that still read `missing[]` directly. Order is
   *  `blockers` first, then `warnings`. */
  missing: ResearchMissingCode[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function uniqueMissing(codes: ResearchMissingCode[]): ResearchMissingCode[] {
  return Array.from(new Set(codes));
}

function buildResult(
  blockers: ResearchMissingCode[],
  warnings: ResearchMissingCode[],
  readiness: ResearchReadiness,
): EvaluateReadinessResult {
  return {
    readiness,
    blockers,
    warnings,
    missing: uniqueMissing([...blockers, ...warnings]),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function evaluateReadiness(
  input: EvaluateReadinessInput,
): Promise<EvaluateReadinessResult> {
  // Trip row — used for status, destination, and dates.
  const [trip] = await db.select().from(sharedTrips)
    .where(eq(sharedTrips.id, input.tripId)).limit(1);
  if (!trip) {
    // Trip is missing entirely. Treat as a hard blocker even though the code
    // matches the soft `TRIP_NOT_ACTIVE` advisory — you cannot research
    // what does not exist. Surfacing `TRIP_NOT_ACTIVE` keeps the wire
    // contract identical to the pre-Phase-2 behavior.
    return buildResult(["TRIP_NOT_ACTIVE"], [], "NEEDS_SETUP");
  }

  // Cheap config checks FIRST so we can return specific gap codes
  // (DESTINATION_NOT_CONFIGURED, DATES_MISSING) before the membership /
  // brief-mode guard short-circuits on missing destinations.
  if (trip.destinationCandidates.length === 0) {
    return buildResult(["DESTINATION_NOT_CONFIGURED"], [], "NEEDS_SETUP");
  }
  if (!trip.travelDateStart || !trip.travelDateEnd) {
    return buildResult(["DATES_MISSING"], [], "NEEDS_SETUP");
  }

  // Membership and brief-mode eligibility come next. After Phase B the
  // status filter is removed, so this only catches membership / brief-mode
  // failures — those are real blockers, not advisory. The catch masks the
  // underlying 403/422 with `TRIP_NOT_ACTIVE` for wire stability; the
  // membership and brief-mode errors still propagate to callers that do
  // not go through `evaluateReadiness`.
  try {
    await requireResearchEligible(
      input.tripId,
      input.ownerUserId,
      trip.destinationCandidates,
    );
  } catch {
    return buildResult(["TRIP_NOT_ACTIVE"], [], "NEEDS_SETUP");
  }

  const blockers = new Set<ResearchMissingCode>();
  const warnings = new Set<ResearchMissingCode>();

  // Trip-lifecycle advisory. Active statuses (PLANNING / CONFIRMED / BOOKED)
  // do not warn; DRAFT / STALE / CANCELED emit `TRIP_NOT_ACTIVE` so the
  // owner sees a soft reminder but is still allowed to run research.
  if (TRIP_STATUSES_WITH_ADVISORY.has(trip.status)) {
    warnings.add("TRIP_NOT_ACTIVE");
  }

  // ─── Capability-specific gates ────────────────────────────────────────────
  const needs = new Set(input.requestedCapabilities);

  if (needs.has("flight") || needs.has("activities") || needs.has("mobility")) {
    const [latestFlightPref] = await db.select().from(tripSearchPreferences)
      .where(eq(tripSearchPreferences.tripId, input.tripId))
      .orderBy(desc(tripSearchPreferences.version)).limit(1);
    if (!latestFlightPref) {
      warnings.add("FLIGHT_PREFERENCES_MISSING");
    }
  }

  if (needs.has("hotel")) {
    const providerEnabled = process.env.PLAN_ENABLE_HOTEL === "true";
    if (!providerEnabled) {
      blockers.add("HOTEL_PROVIDER_NOT_APPROVED");
    } else {
      const [latestStayPref] = await db.select().from(tripStaySearchPreferences)
        .where(eq(tripStaySearchPreferences.tripId, input.tripId))
        .orderBy(desc(tripStaySearchPreferences.version)).limit(1);
      if (!latestStayPref) {
        warnings.add("STAY_PREFERENCES_MISSING");
      }
      const boundProvider = resolvePersistedHotelProviderName();
      if (boundProvider === "nuitee_connect") {
        const authorization = await loadActiveQuoteNationality({
          tripId: input.tripId,
          memberId: input.ownerUserId,
        });
        if (!authorization) {
          blockers.add("QUOTE_NATIONALITY_AUTHORIZATION_MISSING");
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
      return buildResult(
        ["ROUTE_ENDPOINTS_UNCONFIRMED", "MODE_NOT_CHOSEN"],
        [],
        "NEEDS_PLACE_SELECTION",
      );
    }
    const places = await db.select({ id: tripPlaces.id }).from(tripPlaces).where(and(
      eq(tripPlaces.tripId, input.tripId),
      eq(tripPlaces.status, "ACTIVE"),
      ne(tripPlaces.visibility, "OWNER_PRIVATE"),
    ));
    const activeIds = new Set(places.map((place) => place.id));
    if (selection && (!activeIds.has(selection.originPlaceId) || !activeIds.has(selection.destinationPlaceId))) {
      return buildResult(["ROUTE_ENDPOINTS_UNCONFIRMED"], [], "NEEDS_PLACE_SELECTION");
    }
    if (!selection && activeIds.size < 2) return buildResult(["ROUTE_ENDPOINTS_UNCONFIRMED"], [], "NEEDS_PLACE_SELECTION");
  }

  // ─── Default collapse ─────────────────────────────────────────────────────
  // Blockers win over warnings: if any hard blocker exists we surface
  // NEEDS_SETUP. Otherwise a non-empty warnings set means READY_WITH_WARNINGS.
  // The empty case is plain READY. Both READY and READY_WITH_WARNINGS are
  // research-eligible; only the soft path is gated by the real-provider
  // confirmation modal in the web client.
  if (blockers.size > 0) {
    return buildResult(Array.from(blockers), Array.from(warnings), "NEEDS_SETUP");
  }
  if (warnings.size > 0) {
    return buildResult([], Array.from(warnings), "READY_WITH_WARNINGS");
  }
  return buildResult([], [], "READY");
}