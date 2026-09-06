import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TravelApi } from "@/lib/api";
import type { ProfileMemoryResponse } from "@/lib/api/contracts";
import { renderWithIntl } from "@/test/render";

import { ProfileMemory } from "./profile-memory";

const FACT_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID = "22222222-2222-4222-8222-222222222222";

function memory(overrides: Partial<ProfileMemoryResponse> = {}): ProfileMemoryResponse {
  return {
    facts: [{
      id: FACT_ID,
      fieldKey: "trip_pace",
      value: "relaxed",
      category: "PREFERENCE",
      source: "PROFILE_FORM",
      status: "ACTIVE",
      updatedAt: "2026-08-01T10:00:00.000Z",
    }],
    suggestions: [],
    ...overrides,
  };
}

const SUGGESTION = {
  id: PROPOSAL_ID,
  fieldKey: "trip_pace",
  value: "packed",
  observationCount: 4,
  distinctTripCount: 2,
  expiresAt: "2026-12-01T10:00:00.000Z",
};

function createApi(overrides: Partial<TravelApi> = {}): TravelApi {
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
    getProfileMemory: vi.fn().mockResolvedValue(memory()),
    updateMemoryFact: vi.fn(),
    deleteMemoryFact: vi.fn().mockResolvedValue(undefined),
    confirmMemoryProposal: vi.fn().mockResolvedValue({ status: "CONFIRMED", factId: FACT_ID }),
    dismissMemoryProposal: vi.fn().mockResolvedValue({ status: "DISMISSED" }),
    getTripMemoryOverrides: vi.fn().mockResolvedValue({ overrides: [] }),
    getTripMemoryGroupDecisions: vi.fn().mockResolvedValue({ groupDecisions: [] }),
    saveTripMemoryOverride: vi.fn(),
    saveTripMemoryGroupDecision: vi.fn(),
    deleteTripMemory: vi.fn(),
    rememberHighlight: vi.fn(),
    getPreferenceCard: vi.fn().mockResolvedValue({ show: false, fields: [] }),
    resolvePreferenceCard: vi.fn().mockResolvedValue({ applied: [] }),
    getMemoryNotes: vi.fn().mockResolvedValue({ notes: [] }),
    deleteMemoryNote: vi.fn(),
    ...overrides,
  } as TravelApi;
}

afterEach(cleanup);

describe("ProfileMemory", () => {
  it("lists confirmed facts with their provenance", async () => {
    renderWithIntl(<ProfileMemory />, { api: createApi() });

    expect(await screen.findByText("Trip pace")).toBeInTheDocument();
    expect(screen.getByText("relaxed")).toBeInTheDocument();
    expect(screen.getByText("You set this")).toBeInTheDocument();
  });

  it("labels profile-only memory fields in Chinese without missing-message errors", async () => {
    const api = createApi({
      getProfileMemory: vi.fn().mockResolvedValue(memory({
        facts: [
          { ...memory().facts[0], id: "33333333-3333-4333-8333-333333333333", fieldKey: "nationality", value: "CN" },
          { ...memory().facts[0], id: "44444444-4444-4444-8444-444444444444", fieldKey: "date_of_birth", value: "1990-01-01" },
        ],
      })),
    });
    renderWithIntl(<ProfileMemory />, { api, locale: "zh" });

    expect(await screen.findByText("国籍")).toBeInTheDocument();
    expect(screen.getByText("出生日期")).toBeInTheDocument();
  });

  it("shows an empty state when nothing has been remembered", async () => {
    const api = createApi({
      getProfileMemory: vi.fn().mockResolvedValue({ facts: [], suggestions: [] }),
    });
    renderWithIntl(<ProfileMemory />, { api });

    expect(await screen.findByText("Nothing remembered yet")).toBeInTheDocument();
  });

  it("contrasts the current setting against the candidate", async () => {
    const api = createApi({
      getProfileMemory: vi.fn().mockResolvedValue(memory({ suggestions: [SUGGESTION] })),
    });
    renderWithIntl(<ProfileMemory />, { api });

    expect(await screen.findByText(/You set Trip pace to relaxed/)).toBeInTheDocument();
    expect(screen.getByText("Based on 4 independent choices")).toBeInTheDocument();
  });

  it("never renders dates, trip references or a score", async () => {
    const api = createApi({
      getProfileMemory: vi.fn().mockResolvedValue(memory({ suggestions: [SUGGESTION] })),
    });
    const { container } = renderWithIntl(<ProfileMemory />, { api });

    await screen.findByText(/You set Trip pace to relaxed/);
    const rendered = container.textContent ?? "";

    // Section 5.4 forbids surfacing any of these to the user.
    expect(rendered).not.toContain("2026-12-01");
    expect(rendered).not.toContain("2026-08-01");
    expect(rendered).not.toContain(PROPOSAL_ID);
    expect(rendered).not.toContain(FACT_ID);
    expect(rendered.toLowerCase()).not.toContain("activation");
  });

  it("confirms a suggestion through the owner-only endpoint", async () => {
    const confirmMemoryProposal = vi.fn().mockResolvedValue({ status: "CONFIRMED", factId: FACT_ID });
    const api = createApi({
      getProfileMemory: vi.fn().mockResolvedValue(memory({ suggestions: [SUGGESTION] })),
      confirmMemoryProposal,
    });
    renderWithIntl(<ProfileMemory />, { api });

    fireEvent.click(await screen.findByRole("button", { name: /Confirm update/ }));

    await waitFor(() => expect(confirmMemoryProposal).toHaveBeenCalledWith(PROPOSAL_ID));
  });

  it("dismisses a suggestion without creating a fact", async () => {
    const dismissMemoryProposal = vi.fn().mockResolvedValue({ status: "DISMISSED" });
    const api = createApi({
      getProfileMemory: vi.fn().mockResolvedValue(memory({ suggestions: [SUGGESTION] })),
      dismissMemoryProposal,
    });
    renderWithIntl(<ProfileMemory />, { api });

    fireEvent.click(await screen.findByRole("button", { name: /Not now/ }));

    await waitFor(() => expect(dismissMemoryProposal).toHaveBeenCalledWith(PROPOSAL_ID));
    expect(api.confirmMemoryProposal).not.toHaveBeenCalled();
  });

  it("refetches memory after a mutation so resolved cards disappear", async () => {
    const getProfileMemory = vi.fn()
      .mockResolvedValueOnce(memory({ suggestions: [SUGGESTION] }))
      .mockResolvedValue(memory({ suggestions: [] }));
    const api = createApi({ getProfileMemory });
    renderWithIntl(<ProfileMemory />, { api });

    fireEvent.click(await screen.findByRole("button", { name: /Confirm update/ }));

    // Confirming can clear other suggestions server-side, so the whole query is
    // invalidated rather than patched locally.
    await waitFor(() => expect(getProfileMemory).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Confirm update/ })).not.toBeInTheDocument();
    });
  });

  it("deletes a remembered fact", async () => {
    const deleteMemoryFact = vi.fn().mockResolvedValue(undefined);
    const api = createApi({ deleteMemoryFact });
    renderWithIntl(<ProfileMemory />, { api });

    fireEvent.click(await screen.findByRole("button", { name: "Delete this memory" }));

    await waitFor(() => expect(deleteMemoryFact).toHaveBeenCalledWith(FACT_ID));
  });
});
