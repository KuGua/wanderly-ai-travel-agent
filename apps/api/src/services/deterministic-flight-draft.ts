/**
 * Builds a flight search from the trip's own confirmed brief, with no model
 * involvement at all.
 *
 * Every earlier attempt to reach a flight search went through the model
 * deciding to call the tool, and it does not: measured over a complete brief,
 * across the natural phrasing and the hard-coded 确认搜索机票, the tool was
 * invoked zero times and the traveller got a safety refusal instead. The model
 * is asked to obey an instruction that already says "本轮响应**仅**包含函数
 * 调用" — there is no stronger wording left to try.
 *
 * So the decision moves off the model entirely. Nothing here classifies
 * intent, which is the point: an intent classifier is the largest remaining
 * source of wrong answers, and the trip brief already says everything a search
 * needs. The search runs when the facts to run it exist, once per distinct set
 * of facts, and the evidence is waiting by the time anybody asks about flights.
 */

import { airportsForCity, type AirportForCity } from "../location-reference/airport-reference.js";
import type { PersonalTripContext } from "../skills/personal/personal-trip-context-schema.js";
import { personalResearchFlightDraftSchema } from "../types/schemas.js";

type PersonalResearchFlightDraft = import("zod").infer<typeof personalResearchFlightDraftSchema>;

/**
 * The defaults the "Start planning" card already names on screen, and the same
 * ones `POST /trips/:tripId/activate` writes as confirmed search preferences.
 * Reusing them rather than inventing a second set means a traveller who never
 * changes anything sees one trip, not two different ones either side of
 * activation.
 */
const DEFAULT_ADULTS = 1;
const DEFAULT_CABIN = "ECONOMY" as const;
const DEFAULT_CURRENCY = "CNY";

export interface DeterministicFlightDraft {
  draft: PersonalResearchFlightDraft;
  /**
   * Present when either end of the route flies through a neighbouring city's
   * airport. Carried out of here as data rather than baked into prose: the
   * model cannot be relied on to repeat it, and a Kyoto search that answers
   * with Osaka departures and no explanation reads as a bug.
   */
  substitutions: {
    origin?: NonNullable<AirportForCity["substitution"]>;
    destination?: NonNullable<AirportForCity["substitution"]>;
  };
}

/**
 * Why no search could be built. Each value names something a person could act
 * on, because the reply has to be able to say which one it was — "no flights"
 * and "I don't know which airport serves this place" are different answers.
 */
export type FlightDraftGap =
  | "NO_ORIGIN_CITY"
  | "NO_DESTINATION_CITY"
  | "NO_DEPARTURE_DATE"
  | "ORIGIN_HAS_NO_AIRPORT"
  | "DESTINATION_HAS_NO_AIRPORT"
  | "SAME_AIRPORT"
  | "DEPARTURE_IN_PAST";

export type DeterministicFlightDraftResult =
  | { outcome: "READY"; value: DeterministicFlightDraft }
  | { outcome: "GAP"; gap: FlightDraftGap };

/** Today in UTC, as the calendar date the brief's own dates are written in. */
function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function buildDeterministicFlightDraft(
  tripContext: Pick<
    PersonalTripContext,
    "departureCities" | "destinationCandidates" | "travelDateStart" | "travelDateEnd"
  >,
  now: Date = new Date(),
): DeterministicFlightDraftResult {
  const originCity = tripContext.departureCities[0];
  const destinationCity = tripContext.destinationCandidates[0];
  if (!originCity) return { outcome: "GAP", gap: "NO_ORIGIN_CITY" };
  if (!destinationCity) return { outcome: "GAP", gap: "NO_DESTINATION_CITY" };
  if (!tripContext.travelDateStart) return { outcome: "GAP", gap: "NO_DEPARTURE_DATE" };

  // A brief can outlive its own dates — a trip drafted in March and reopened in
  // October still holds March's departure. Searching it would spend a call to
  // return nothing, and answer a question nobody asked.
  if (tripContext.travelDateStart < todayIso(now)) {
    return { outcome: "GAP", gap: "DEPARTURE_IN_PAST" };
  }

  const origin = airportsForCity(originCity);
  const destination = airportsForCity(destinationCity);
  if (origin.airportIds.length === 0) return { outcome: "GAP", gap: "ORIGIN_HAS_NO_AIRPORT" };
  if (destination.airportIds.length === 0) return { outcome: "GAP", gap: "DESTINATION_HAS_NO_AIRPORT" };

  const originId = origin.airportIds[0]!;
  const destinationId = destination.airportIds[0]!;
  // Two cities close enough to share an airport is a ground trip, not a
  // flight. Suppliers reject the route anyway; failing here says why.
  if (originId === destinationId) return { outcome: "GAP", gap: "SAME_AIRPORT" };

  const returnDate = tripContext.travelDateEnd;
  const parsed = personalResearchFlightDraftSchema.safeParse({
    kind: "FLIGHT_SEARCH",
    originId,
    destinationId,
    tripType: returnDate ? "ROUND_TRIP" : "ONE_WAY",
    departureDate: tripContext.travelDateStart,
    returnDate: returnDate ?? null,
    adults: DEFAULT_ADULTS,
    cabin: DEFAULT_CABIN,
    currency: DEFAULT_CURRENCY,
  });
  // The schema owns the cross-field rules (a return date on or after the
  // departure, a return date whenever the trip is a round trip). Anything it
  // rejects is a brief that cannot currently describe a flight, not a bug to
  // route around here.
  if (!parsed.success) return { outcome: "GAP", gap: "NO_DEPARTURE_DATE" };

  return {
    outcome: "READY",
    value: {
      draft: parsed.data,
      substitutions: {
        ...(origin.substitution ? { origin: origin.substitution } : {}),
        ...(destination.substitution ? { destination: destination.substitution } : {}),
      },
    },
  };
}
