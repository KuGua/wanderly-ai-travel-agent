import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlanProposalCard } from "./plan-proposal-card";
import type { ListedPlan } from "@/lib/api/contracts";
import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";

const TRIP_ID = "00000000-0000-0000-4000-0000000000aa";
const PLAN_ID = "00000000-0000-0000-4000-000000000001";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function buildApi(overrides: Partial<TravelApi> = {}): TravelApi {
  return {
    getMyProfile: vi.fn(),
    updateMyProfile: vi.fn(),
    getTrips: vi.fn(),
    getTrip: vi.fn(),
    getLocationReference: vi.fn(),
    getLocationIntroduction: vi.fn(),
    getTripThreads: vi.fn(),
    createTripThread: vi.fn(),
    getOrCreateDefaultTripThread: vi.fn(),
    getOwnerConversation: vi.fn(),
    submitConversationTurn: vi.fn(),
    getAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
    subscribeAgentRun: vi.fn(),
    startExploration: vi.fn(),
    activateTrip: vi.fn(),
    updateTripTitle: vi.fn(),
    saveTripSearchPreferences: vi.fn(),
    startPlanning: vi.fn(),
    getLatestPlanningRun: vi.fn(),
    getLatestPlan: vi.fn(),
    getProfileMemory: vi.fn(),
    updateMemoryFact: vi.fn(),
    deleteMemoryFact: vi.fn(),
    confirmMemoryProposal: vi.fn(),
    dismissMemoryProposal: vi.fn(),
    getTripMemoryOverrides: vi.fn(),
    getTripMemoryGroupDecisions: vi.fn(),
    saveTripMemoryOverride: vi.fn(),
    saveTripMemoryGroupDecision: vi.fn(),
    deleteTripMemory: vi.fn(),
    rememberHighlight: vi.fn(),
    getPreferenceCard: vi.fn(),
    resolvePreferenceCard: vi.fn(),
    getMemoryNotes: vi.fn(),
    deleteMemoryNote: vi.fn(),
    listTripPlans: vi.fn(),
    listAdoptionVotes: vi.fn().mockResolvedValue({
      planId: PLAN_ID,
      votesAccepted: 1,
      votesRequired: 3,
      hasBlocker: false,
      currentUserDecision: null,
    }),
    castAdoptionVote: vi.fn().mockResolvedValue({
      planId: PLAN_ID,
      outcome: "CAST",
      votesAccepted: 1,
      votesRequired: 3,
    }),
    ...overrides,
  };
}

function renderCard(plan: ListedPlan) {
  return renderWithIntl(<PlanProposalCard plan={plan} tripId={TRIP_ID} />, { api: buildApi() });
}

function makePlan(overrides: Partial<ListedPlan> = {}): ListedPlan {
  return {
    id: PLAN_ID,
    version: 1,
    status: "PROPOSED",
    snapshotId: "00000000-0000-0000-4000-000000000002",
    generatedAt: "2026-09-01T00:00:00.000Z",
    destination: "Tokyo",
    destinationCandidatesEvaluated: ["Tokyo"],
    replacedByPlanId: null,
    staleReason: null,
    planData: {},
    ...overrides,
  };
}

describe("PlanProposalCard — rendering rules (§7.3, §10.2)", () => {
  it("renders destination, version, and status badge", () => {
    renderCard(makePlan({ version: 3, status: "PROPOSED" }));
    const card = screen.getByTestId(`plan-proposal-card-${PLAN_ID}`);
    expect(card.textContent).toContain("Tokyo");
    expect(card.textContent).toContain("v3");
    expect(card.getAttribute("data-status")).toBe("PROPOSED");
    expect(card.getAttribute("data-version")).toBe("3");
  });

  it("renders price with currency, source, and capturedAt on flight lines", () => {
    renderCard(makePlan({
      planData: {
        flights: [{
          origin: "SFO",
          destination: "NRT",
          totalPrice: 1234.56,
          currency: "USD",
          source: "TestAir",
          capturedAt: "2026-09-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
          segments: [{
            origin: "SFO",
            destination: "NRT",
            carrier: "TA",
            flightNumber: "101",
          }],
        }],
      },
    }));
    expect(screen.getByText(/USD 1234\.56/)).toBeDefined();
    expect(screen.getByText(/TestAir/)).toBeDefined();
  });

  it("marks expired offers", () => {
    renderCard(makePlan({
      planData: {
        flights: [{
          origin: "SFO",
          destination: "NRT",
          totalPrice: 999,
          currency: "USD",
          source: "TestAir",
          capturedAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2020-01-02T00:00:00.000Z",
        }],
      },
    }));
    // §10.2.10: expired offers must carry the explicit "Offer expired"
    // marker, not be silently dropped. The text content is the
    // accessible name; we locate via data-testid because jsdom has
    // inconsistent role/native semantics for `role="status"` on
    // a span.
    expect(screen.getAllByTestId("plan-offer-expired").length).toBeGreaterThan(0);
  });

  it("renders the UNAVAILABLE gap when stays/hotels/activities are empty", () => {
    // Empty `stays`/`hotels`/`activities` legitimately happen and must each
    // render their own UNAVAILABLE marker.
    renderCard(makePlan({
      planData: {
        flights: [{
          origin: "SFO",
          destination: "NRT",
          totalPrice: 999,
          currency: "USD",
          source: "TestAir",
          capturedAt: "2026-09-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }],
      },
    }));
    // §10.2.9: three gaps — stays, hotels, activities — each with
    // "This capability returned was not collected" copy.
    const cards = screen.getAllByText(/This capability returned was not collected/i);
    expect(cards.length).toBe(3);
  });

  /**
   * 2026-09-05: `flights` stopped being `.min(1)` server-side. A refused
   * flight request used to withhold the entire plan; it is now a capability
   * gap like any other, and the card has to say so rather than quietly
   * omitting the section — a plan that shows stays and no flight row at all
   * reads as "no flights needed", which is a different and false claim.
   */
  it("renders an UNAVAILABLE flight row rather than omitting the section", () => {
    renderCard(makePlan({
      planData: {
        flights: [],
        stays: [{
          name: "Hotel Test",
          totalPrice: 500,
          currency: "USD",
          source: "TestStay",
          capturedAt: "2026-09-01T00:00:00.000Z",
        }],
      },
    }));
    const card = screen.getByTestId(`plan-proposal-card-${PLAN_ID}`);
    expect(card.textContent).toContain("Hotel Test");
    // Assert the flight section specifically, not a total: the card's own
    // section count is a separate concern and has its own quirks.
    const flightSection = screen.getByRole("region", { name: "Flights" });
    expect(flightSection.textContent).toMatch(/This capability returned was not collected/i);
  });

  /**
   * The two accommodation slots carry different shapes, and the card read
   * neither correctly: a Nuitee quote names itself `propertyName`, so every
   * real hotel rendered as "—", and non-priced discovery had no slot at all,
   * leaving the 住宿 row permanently empty over sixteen collected stays.
   */
  it("renders a priced quote by its property name and discovery without a price", () => {
    renderCard(makePlan({
      planData: {
        flights: [],
        hotels: [{
          propertyName: "remm Roppongi",
          totalPrice: 3066.24,
          currency: "CNY",
          source: "Nuitee LiteAPI",
          capturedAt: "2026-09-01T00:00:00.000Z",
        }],
        accommodations: [{
          name: "Jinjiang Hotel",
          kind: "hotels",
          source: "OpenTripMap",
          capturedAt: "2026-09-01T00:00:00.000Z",
        }],
      },
    }));
    const card = screen.getByTestId(`plan-proposal-card-${PLAN_ID}`);
    expect(card.textContent).toContain("remm Roppongi");
    expect(card.textContent).toContain("CNY 3066.24");
    expect(card.textContent).toContain("Jinjiang Hotel");
    // Discovery carries no rate, and must not be dressed up as one.
    const stays = screen.getByRole("region", { name: "Stays" });
    expect(stays.textContent).toContain("OpenTripMap");
    expect(stays.textContent).not.toMatch(/CNY \d/);
  });

  it("renders explanation tokens as localized copy", () => {
    renderCard(makePlan({
      planData: {
        publicExplanationTokens: ["SATISFIES_ALL_PRIVATE_CONSTRAINTS"],
      },
    }));
    expect(screen.getByText(/All member-shared constraints were considered/i)).toBeDefined();
  });

  it("silently drops unknown explanation tokens", () => {
    renderCard(makePlan({
      planData: {
        publicExplanationTokens: ["SATISFIES_ALL_PRIVATE_CONSTRAINTS", "SOME_NEW_TOKEN_NOT_LOCALIZED"],
      },
    }));
    expect(screen.getByText(/All member-shared constraints were considered/i)).toBeDefined();
    // §10.2.11: unknown tokens are not leaked to the UI.
    expect(screen.queryByText("SOME_NEW_TOKEN_NOT_LOCALIZED")).toBeNull();
  });

  it("renders the constraint count when constraintReferences is non-empty", () => {
    renderCard(makePlan({
      planData: {
        constraintReferences: ["ref-1", "ref-2", "ref-3"],
      },
    }));
    expect(screen.getByText(/Cited 3 team constraints/i)).toBeDefined();
  });

  it("hides the vote block on ACTIVE plans", () => {
    renderCard(makePlan({ status: "ACTIVE" }));
    expect(screen.queryByTestId(`plan-vote-block-${PLAN_ID}`)).toBeNull();
  });

  it("hides the vote block on STALE plans", () => {
    renderCard(makePlan({ status: "STALE", staleReason: "STALE_SNAPSHOT_GUARD" }));
    expect(screen.queryByTestId(`plan-vote-block-${PLAN_ID}`)).toBeNull();
  });

  it("shows ACCEPT and NEEDS_CHANGES on PROPOSED plans", () => {
    renderCard(makePlan({ status: "PROPOSED" }));
    const block = screen.getByTestId(`plan-vote-block-${PLAN_ID}`);
    expect(block).toBeDefined();
    expect(screen.getByRole("button", { name: /Accept/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Need changes/i })).toBeDefined();
  });
});