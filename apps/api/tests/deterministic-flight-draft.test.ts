import { describe, expect, it } from "vitest";

import { requiresOwnerConfirmation } from "../src/agents/personal-research-tool-policy.js";
import { buildDeterministicFlightDraft } from "../src/services/deterministic-flight-draft.js";

/**
 * The whole point of this builder is that it makes no judgement calls: given a
 * brief, either a search follows from it or a named gap does. These tests are
 * therefore about the gaps as much as the drafts — a gap that reports the
 * wrong reason is how a traveller ends up being asked for something they
 * already gave.
 */
const NOW = new Date("2026-09-06T12:00:00Z");

function brief(overrides: Partial<Parameters<typeof buildDeterministicFlightDraft>[0]> = {}) {
  return {
    departureCities: ["Singapore"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: "2026-09-27",
    travelDateEnd: "2026-10-03",
    ...overrides,
  };
}

describe("buildDeterministicFlightDraft", () => {
  it("builds a round trip from a complete brief", () => {
    const result = buildDeterministicFlightDraft(brief(), NOW);
    expect(result).toMatchObject({
      outcome: "READY",
      value: {
        draft: {
          kind: "FLIGHT_SEARCH",
          originId: "SIN",
          destinationId: "NRT",
          tripType: "ROUND_TRIP",
          departureDate: "2026-09-27",
          returnDate: "2026-10-03",
          adults: 1,
          cabin: "ECONOMY",
          currency: "CNY",
        },
        substitutions: {},
      },
    });
  });

  it("treats a brief with no return date as one way", () => {
    const result = buildDeterministicFlightDraft(brief({ travelDateEnd: null }), NOW);
    expect(result).toMatchObject({
      outcome: "READY",
      value: { draft: { tripType: "ONE_WAY", returnDate: null } },
    });
  });

  /**
   * Kyoto is the case that started this: a complete, ordinary brief for one of
   * Japan's most-visited cities could not produce a search at all, because the
   * city has no airport of its own.
   */
  it("flies a city with no airport through its nearest one, and says so", () => {
    const result = buildDeterministicFlightDraft(brief({ destinationCandidates: ["Kyoto"] }), NOW);
    expect(result).toMatchObject({
      outcome: "READY",
      value: {
        draft: { originId: "SIN", destinationId: "KIX" },
        substitutions: { destination: { requestedCity: "Kyoto", servingCity: "Osaka" } },
      },
    });
    expect(result).not.toMatchObject({ value: { substitutions: { origin: expect.anything() } } });
  });

  it("reports a substitution at the origin end too", () => {
    const result = buildDeterministicFlightDraft(
      brief({ departureCities: ["Nara"], destinationCandidates: ["Tokyo"] }),
      NOW,
    );
    expect(result).toMatchObject({
      outcome: "READY",
      value: { substitutions: { origin: { requestedCity: "Nara", servingCity: "Osaka" } } },
    });
  });

  it.each([
    [{ departureCities: [] }, "NO_ORIGIN_CITY"],
    [{ destinationCandidates: [] }, "NO_DESTINATION_CITY"],
    [{ travelDateStart: null }, "NO_DEPARTURE_DATE"],
    [{ departureCities: ["Wakanda"] }, "ORIGIN_HAS_NO_AIRPORT"],
    [{ destinationCandidates: ["Wakanda"] }, "DESTINATION_HAS_NO_AIRPORT"],
  ])("names the gap rather than guessing: %o", (overrides, gap) => {
    expect(buildDeterministicFlightDraft(brief(overrides), NOW)).toEqual({ outcome: "GAP", gap });
  });

  it("does not search a departure that has already happened", () => {
    expect(buildDeterministicFlightDraft(
      brief({ travelDateStart: "2026-03-01", travelDateEnd: "2026-03-08" }),
      NOW,
    )).toEqual({ outcome: "GAP", gap: "DEPARTURE_IN_PAST" });
  });

  it("declines a route both ends of which are the same airport", () => {
    // Kyoto and Nara are both served by Kansai. That is a train journey.
    expect(buildDeterministicFlightDraft(
      brief({ departureCities: ["Kyoto"], destinationCandidates: ["Nara"] }),
      NOW,
    )).toEqual({ outcome: "GAP", gap: "SAME_AIRPORT" });
  });

  it("refuses a return date that falls before the departure", () => {
    expect(buildDeterministicFlightDraft(
      brief({ travelDateStart: "2026-10-03", travelDateEnd: "2026-09-27" }),
      NOW,
    )).toMatchObject({ outcome: "GAP" });
  });
});

/**
 * The prefetch saves search state without a confirmation, because it never
 * asked for one. `pendingFlightConfirmation` used to read that column alone
 * and so rendered "Ready to search for flights?" underneath a reply that had
 * already listed the flights. The capability's own policy is the authority.
 */
describe("whether a flight search can be awaiting confirmation at all", () => {
  it("cannot, while flights run on the model's own initiative", () => {
    expect(requiresOwnerConfirmation("flight.search")).toBe(false);
  });
});
