import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TripDetailResponse } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";

import * as navigationStub from "@/test/mock-next-navigation";

import { TripWorkspace } from "./trip-workspace";
import { TripInvitationPage } from "./trip-invitation-page";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_THREAD_ID = "33333333-3333-4333-8333-333333333333";

function buildTripResponse(status: TripDetailResponse["trip"]["status"] = "PLANNING"): TripDetailResponse {
  return {
    trip: {
      id: TRIP_ID,
      name: "Tokyo & Kyoto",
      createdBy: "owner-user-id",
      status,
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo", "Kyoto"],
      travelDateStart: "2026-09-10",
      travelDateEnd: "2026-09-20",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
    },
    callerRole: "CREATOR",
    members: [
      {
        userId: "owner-user-id",
        displayName: "Alice",
        role: "CREATOR",
        isRequired: true,
        joinedAt: "2026-08-01T10:00:00.000Z",
      },
    ],
  };
}

function buildThread(id: string, title: string, isDefault: boolean) {
  return {
    id,
    ownerUserId: "owner-user-id",
    tripId: TRIP_ID,
    scope: "TRIP" as const,
    isDefault,
    title,
    titleSource: "AUTO" as const,
    titleLocale: "en" as const,
    titleUpdatedAt: null,
    createdAt: "2026-08-21T10:00:00.000Z",
    archivedAt: null,
  };
}

function createApi(overrides: Partial<TravelApi> = {}): TravelApi {
  return {
    getMyProfile: vi.fn(),
    updateMyProfile: vi.fn(),
    getTrips: vi.fn(),
    getTrip: vi.fn().mockResolvedValue(buildTripResponse()),
    getLocationReference: vi.fn(),
    getLocationIntroduction: vi.fn(),
    getTripThreads: vi.fn().mockResolvedValue({ threads: [] }),
    createTripThread: vi.fn().mockResolvedValue(buildThread(SECOND_THREAD_ID, "New thread", false)),
    getOrCreateDefaultTripThread: vi.fn().mockResolvedValue(buildThread(DEFAULT_THREAD_ID, "Default", true)),
    getOwnerConversation: vi.fn().mockResolvedValue({ thread: buildThread(DEFAULT_THREAD_ID, "Default", true), messages: [] }),
    submitConversationTurn: vi.fn().mockResolvedValue({
      threadId: DEFAULT_THREAD_ID,
      runId: "00000000-0000-4000-8000-000000000000",
      operation: "CONVERSATION",
      status: "QUEUED",
      generationAttempt: 0,
      userMessage: {
        id: "00000000-0000-4000-8000-000000000001",
        role: "USER",
        content: "hi",
        sequence: 1,
        createdAt: "2026-08-22T10:00:00.000Z",
      },
    }),
    getAgentRun: vi.fn(),
    cancelAgentRun: vi.fn(),
    subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    startExploration: vi.fn(),
    activateTrip: vi.fn(),
    updateTripTitle: vi.fn(),
    saveTripSearchPreferences: vi.fn(),
    startPlanning: vi.fn(),
    // Queried on mount, so it has to resolve: an unstubbed `vi.fn()` returns
    // undefined, which React Query rejects, and the failing query took the
    // conversation down with it.
    getLatestPlanningRun: vi.fn().mockResolvedValue({ run: null }),
    getLatestPlan: vi.fn(),
    createTripInvitation: vi.fn(),
    getProfileMemory: vi.fn().mockResolvedValue({ facts: [], suggestions: [] }),
    updateMemoryFact: vi.fn(),
    deleteMemoryFact: vi.fn(),
    confirmMemoryProposal: vi.fn(),
    dismissMemoryProposal: vi.fn(),
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
    // Shared Plan Surface (Phase 1) — required on TravelApi since the
    // shared view hard-depends on them. TripWorkspace mounts the shared
    // view via `?view=shared`; tests that don't exercise that branch
    // get a benign empty mock.
    listTripPlans: vi.fn().mockResolvedValue({ tripId: "00000000-0000-4000-8000-000000000000", proposed: [], active: [], stale: [] }),
    listAdoptionVotes: vi.fn().mockResolvedValue({
      planId: "00000000-0000-4000-8000-000000000000",
      votesAccepted: 0,
      votesRequired: 0,
      hasBlocker: false,
      currentUserDecision: null,
    }),
    castAdoptionVote: vi.fn().mockResolvedValue({
      planId: "00000000-0000-4000-8000-000000000000",
      outcome: "CAST" as const,
      votesAccepted: 0,
      votesRequired: 0,
    }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("TripWorkspace", () => {
  it("uses floating inspector cards without a desktop inspector frame", async () => {
    const api = createApi({ getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }) });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    await screen.findByText("Trip overview");
    const inspector = document.getElementById("trip-inspector")!;
    expect(inspector).not.toHaveClass("border-l-2", "bg-[var(--w-mist)]");
    expect(inspector).toHaveClass("bg-transparent", "max-xl:border-l-2", "max-xl:bg-[var(--w-mist)]");
    expect(inspector.querySelector("header")).not.toHaveClass("border-b-2", "border-[var(--w-ink)]");
    expect(inspector.querySelector("header")).toHaveClass("max-xl:border-b-2", "max-xl:border-[var(--w-ink)]", "xl:after:right-4");
  });

  it("opens a draft in the same workspace used for active planning", async () => {
    const api = createApi({
      getTrip: vi.fn().mockResolvedValue(buildTripResponse("DRAFT")),
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Draft notes", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: /Draft notes/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Activate draft trip" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Invite teammates" })).toHaveAttribute("href", `/trips/${TRIP_ID}/invite`);
    // The overview card no longer carries an activation CTA. Scoped to the
    // card: the chat has its own unrelated "Start planning" for the shared
    // plan, and matching on the label alone finds that one instead.
    const overview = screen.getByRole("region", { name: "Trip overview" });
    expect(within(overview).queryByRole("button", { name: "Start planning" })).not.toBeInTheDocument();
  });

  it("shows no activation CTA on a team Draft, whatever its destination count", async () => {
    const draft = buildTripResponse("DRAFT");
    draft.trip.destinationCandidates = ["Tokyo", "Kyoto", "Osaka", "Nara"];
    draft.members.push({
      userId: "bob-user-id",
      displayName: "Bob",
      role: "MEMBER",
      isRequired: true,
      joinedAt: "2026-08-02T10:00:00.000Z",
    });
    const api = createApi({ getTrip: vi.fn().mockResolvedValue(draft) });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("link", { name: "Invite teammates" })).toBeInTheDocument();
    const overview = screen.getByRole("region", { name: "Trip overview" });
    expect(within(overview).queryByRole("button", { name: "Start planning" })).not.toBeInTheDocument();
  });

  it("auto-provisions a default thread when none exists", async () => {
    // First call returns empty (no threads yet); subsequent calls
    // return the freshly-provisioned default thread.
    const getTripThreads = vi.fn()
      .mockResolvedValueOnce({ threads: [] })
      .mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] });
    const api = createApi({ getTripThreads });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    await waitFor(() => expect(api.getOrCreateDefaultTripThread).toHaveBeenCalledWith(TRIP_ID));

    // After provisioning the rail shows the default thread title.
    expect(await screen.findByRole("button", { name: /Default/ })).toBeInTheDocument();
  });

  it("renders only the caller's own threads, not trip-mate threads", async () => {
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({
        threads: [
          buildThread(DEFAULT_THREAD_ID, "Visa prep", true),
          buildThread(SECOND_THREAD_ID, "Budget", false),
        ],
      }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: /Visa prep/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Budget/ })).toBeInTheDocument();

    // Rail does NOT list any trip-mate thread.
    expect(screen.queryByRole("button", { name: /Alice/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Bob/ })).not.toBeInTheDocument();
  });

  it("gives the rail item's top-right corner a single owner", async () => {
    // jsdom has no layout engine, so this asserts the invariant that the
    // geometry depended on rather than the geometry itself: the "Current"
    // badge and the thread-actions trigger both used to anchor themselves to
    // `absolute right-2 top-2`, and on the selected thread the opaque trigger
    // was painted straight over the badge.
    vi.spyOn(navigationStub, "useSearchParams")
      .mockReturnValue(new URLSearchParams(`thread=${DEFAULT_THREAD_ID}`));
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    const trigger = await screen.findByRole("button", { name: "Thread actions" });
    const item = trigger.closest("li");
    expect(item).not.toBeNull();

    // Both are on screen at once — that was never the problem.
    expect(within(item!).getByText("Current")).toBeInTheDocument();

    const cornerAnchored = [...item!.querySelectorAll<HTMLElement>("*")].filter((el) =>
      el.classList.contains("absolute")
      && el.classList.contains("right-2")
      && [...el.classList].some((name) => name.startsWith("top-2")));
    expect(cornerAnchored).toHaveLength(1);
    expect(cornerAnchored[0]).toBe(trigger);
  });

  it("writes the trip's auto title in the language the traveller is reading", async () => {
    // The server can only localize the title it is told to localize. This
    // call site once passed nothing and inherited the "en" default, which
    // named a Chinese traveller's trip half in English.
    vi.spyOn(navigationStub, "useSearchParams")
      .mockReturnValue(new URLSearchParams(`thread=${DEFAULT_THREAD_ID}`));
    const trip = buildTripResponse("DRAFT");
    const api = createApi({
      getTrip: vi.fn().mockResolvedValue({
        ...trip,
        trip: { ...trip.trip, pendingBriefProposal: { destinationCandidates: ["新加坡"], travelDays: 4 } },
      }),
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
      updateDraftTripBrief: vi.fn().mockResolvedValue({
        trip: {
          id: TRIP_ID, name: "新加坡行程规划｜4天", nameSource: "AUTO", status: "DRAFT",
          departureCities: [], destinationCandidates: ["新加坡"],
          travelDateStart: null, travelDateEnd: null, travelDays: 4,
          updatedAt: "2026-09-03T10:00:00.000Z",
        },
      }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api, locale: "zh" });

    // The card offers two ways forward now; this is the one that saves.
    fireEvent.click(await screen.findByRole("button", { name: /保存到这趟行程/ }));

    await waitFor(() => {
      expect(api.updateDraftTripBrief).toHaveBeenCalledWith(TRIP_ID, expect.objectContaining({
        titleLocale: "zh",
      }));
    });
  });

  it("does not revive the retired brief destination card from legacy trip data", async () => {
    // Destination decisions are now served exclusively by the durable
    // Destination Cue batch. A stale destination-only brief must not render
    // the old generic save/dismiss card or write anything to the trip.
    const trip = buildTripResponse("DRAFT");
    const updateDraftTripBrief = vi.fn();
    const api = createApi({
      getTrip: vi.fn().mockResolvedValue({
        ...trip,
        trip: { ...trip.trip, pendingBriefProposal: { destinationCandidates: ["Indonesia"] } },
      }),
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
      updateDraftTripBrief,
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: "New thread" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save Indonesia to this trip/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Leave it as it is/ })).not.toBeInTheDocument();
    expect(updateDraftTripBrief).not.toHaveBeenCalled();
  });

  it("tells the traveller a thread is coming while the list loads, and stops once it arrives", async () => {
    // Unlike the exploration surface, the workspace is always on its way to a
    // thread, so "preparing" here is a true statement — and it must clear.
    vi.spyOn(navigationStub, "useSearchParams")
      .mockReturnValue(new URLSearchParams(`thread=${DEFAULT_THREAD_ID}`));
    let release: (value: { threads: ReturnType<typeof buildThread>[] }) => void = () => {};
    const api = createApi({
      getTripThreads: vi.fn().mockReturnValue(new Promise((resolve) => {
        release = resolve;
      })),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByText("Preparing your private chat…")).toBeInTheDocument();

    release({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] });

    await waitFor(() => {
      expect(screen.queryByText("Preparing your private chat…")).not.toBeInTheDocument();
    });
  });

  it("hands the active private thread to the full-map route", async () => {
    vi.spyOn(navigationStub, "useSearchParams")
      .mockReturnValue(new URLSearchParams(`thread=${DEFAULT_THREAD_ID}`));
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("link", { name: "Open in full map" })).toHaveAttribute(
      "href",
      `/home?fromTrip=${TRIP_ID}&thread=${DEFAULT_THREAD_ID}`,
    );
  });

  it("keeps hotel-search follow-up inside the chat rather than rendering a setup card", async () => {
    // The workspace reads the active thread out of `?thread=`, and the send
    // button stays disabled without one. Selecting a thread in the rail goes
    // through `router.push`, which the navigation stub does not carry back
    // into `useSearchParams`, so the parameter is supplied directly.
    vi.spyOn(navigationStub, "useSearchParams")
      .mockReturnValue(new URLSearchParams(`thread=${DEFAULT_THREAD_ID}`));
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
      getAgentRun: vi.fn().mockResolvedValue({
        runId: "00000000-0000-4000-8000-000000000000",
        operation: "CONVERSATION",
        status: "RUNNING",
        generationAttempt: 1,
        attemptCount: 1,
        createdAt: "2026-08-22T10:00:00.000Z",
        updatedAt: "2026-08-22T10:00:00.000Z",
        finishedAt: null,
        errorCode: null,
        assistantMessageId: null,
        resultPlanId: null,
        researchIntentDraft: null,
        researchIntentState: null,
      }),
      subscribeAgentRun: vi.fn().mockImplementation(async (_runId, signal, onEvent) => {
        onEvent({
          event: "message.delta",
          runId: "00000000-0000-4000-8000-000000000000",
          generationAttempt: 1,
          sequence: 0,
          delta: "请告诉我入住和退房日期，以及入住人数和房间数。",
        });
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    const input = await screen.findByRole("textbox", { name: "Message Wanderly Agent" });
    fireEvent.change(input, { target: { value: "请你帮我搜搜看西门町附近的酒店" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("请告诉我入住和退房日期，以及入住人数和房间数。")).toBeInTheDocument();
    expect(screen.queryByTestId("research-confirmation-card")).not.toBeInTheDocument();
  });

  it("starts a new thread session in one click; the server owns the auto-numbered title", async () => {
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: /Default/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    // Server is the authority on the auto-numbered title (see
    // docs/thread-title-lifecycle-implementation.md §10.2 / D1). The client
    // only sends the locale so the server can pick the right language.
    await waitFor(() =>
      expect(api.createTripThread).toHaveBeenCalledWith(TRIP_ID, { titleLocale: "en" }),
    );
    expect(screen.queryByPlaceholderText(/Visa prep/)).not.toBeInTheDocument();
  });

  // Every `applied: false` reason must reach the traveller as prose. The
  // first implementation built the message key by case-converting the reason,
  // which silently worked for REJECTED/UNAVAILABLE and produced a missing key
  // for the two underscored ones — so both halves are asserted here.
  it.each([
    ["MANUAL_LOCKED", "This thread was renamed by you. Confirm to let AI name it instead."],
    ["NO_MATERIAL", "Send at least one message before asking AI to name this thread."],
    ["REJECTED", "AI couldn't produce a safe title — try again or rename manually."],
    ["UNAVAILABLE", "AI naming is temporarily unavailable — try again or rename manually."],
  ] as const)("explains a refused AI naming attempt (%s) and keeps the title", async (reason, message) => {
    const thread = buildThread(DEFAULT_THREAD_ID, "New chat 1", false);
    const suggestThreadTitle = vi.fn().mockResolvedValue({ thread, applied: false, reason });
    const api = createApi({
      suggestThreadTitle,
      getTripThreads: vi.fn().mockResolvedValue({ threads: [thread] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    fireEvent.click(await screen.findByRole("button", { name: "Thread actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Name with AI" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    // The refusal is informational: the stored title is untouched.
    expect(screen.getByRole("button", { name: /New chat 1/ })).toBeInTheDocument();
  });

  it("reports an AI naming request that fails outright as unavailable", async () => {
    const thread = buildThread(DEFAULT_THREAD_ID, "New chat 1", false);
    const api = createApi({
      suggestThreadTitle: vi.fn().mockRejectedValue(new Error("network")),
      getTripThreads: vi.fn().mockResolvedValue({ threads: [thread] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    fireEvent.click(await screen.findByRole("button", { name: "Thread actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Name with AI" }));

    expect(
      await screen.findByText("AI naming is temporarily unavailable — try again or rename manually."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New chat 1/ })).toBeInTheDocument();
  });

  it("lets the creator set a manual title", async () => {
    const updateTripTitle = vi.fn().mockResolvedValue({
      trip: { id: TRIP_ID, name: "Autumn escape", nameSource: "MANUAL", titleLocale: null, updatedAt: "2026-08-22T10:00:00.000Z" },
    });
    const api = createApi({ updateTripTitle, getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }) });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    fireEvent.click(await screen.findByRole("button", { name: /Rename/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /Trip title/ }), { target: { value: "Autumn escape" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateTripTitle).toHaveBeenCalledWith(TRIP_ID, { name: "Autumn escape" }));
  });

  it("places the creator-only invitation control above the trip overview", async () => {
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    const invite = await screen.findByRole("link", { name: "Invite teammates" });
    const overview = screen.getByText("Trip overview");
    expect(invite.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(invite).toHaveAttribute("href", `/trips/${TRIP_ID}/invite`);
  });

  it("lets a creator create an email-bound invite link", async () => {
    const createTripInvitation = vi.fn().mockResolvedValue({
      invitationId: "55555555-5555-4555-8555-555555555555",
      inviteToken: "a".repeat(43),
      expiresAt: "2026-09-06T00:00:00.000Z",
    });
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
      createTripInvitation,
    });
    renderWithIntl(<TripInvitationPage tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("heading", { name: "Current members" })).toBeInTheDocument();
    expect(screen.getByText("Creator")).toBeInTheDocument();
    expect(screen.queryByText(/trips\.workspace\.invitation\.roleValue/)).not.toBeInTheDocument();
    fireEvent.change(await screen.findByRole("textbox", { name: "Teammate email" }), { target: { value: "bob@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));

    await waitFor(() => expect(createTripInvitation).toHaveBeenCalledWith(TRIP_ID, expect.objectContaining({ recipientEmail: "bob@example.test" })));
    expect(await screen.findByLabelText("One-time invite link")).toHaveValue(`http://localhost:3000/en/trips/join/${"a".repeat(43)}?email=bob%40example.test`);
  });

  it("shows a generic membership-revoked error on 403/410 from the trip detail", async () => {
    const api = createApi({
      getTrip: vi.fn().mockRejectedValue(new TravelApiError("forbidden", 403, "Forbidden", null)),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByText(/You no longer have access to this trip/i)).toBeInTheDocument();
  });

  it("falls back to the default thread when the URL points at a thread no longer in the list", async () => {
    // Pre-set the URL ?thread= to an id that is NOT in the threads list
    // returned by getTripThreads.  The workspace should fall back to the
    // default thread in the rail.
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, search: "?thread=stale-id", href: "http://localhost/trips/" + TRIP_ID + "?thread=stale-id" },
    });

    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    // The rail must still render the only available thread (the default).
    expect(await screen.findByRole("button", { name: /Default/ })).toBeInTheDocument();
  });

  it("threads are owner-scoped: even when both threads have the same title, only the caller's threads appear", async () => {
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByRole("button", { name: /Default/ })).toBeInTheDocument();

    // Sanity: only one Default entry; the rail does not list other trip-mates' threads.
    expect(screen.getAllByRole("button", { name: /Default/ })).toHaveLength(1);
  });

  it("keeps the overview to where the trip starts and ends", async () => {
    // Members and Status were duplicating what the Members panel and the
    // status pill above them already say; the overview is the route now.
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    const overview = (await screen.findByText("Trip overview")).closest("section")!;
    expect(within(overview).getByText("Departure")).toBeInTheDocument();
    expect(within(overview).getByText("Candidate destinations")).toBeInTheDocument();
    expect(within(overview).queryByText("Status")).not.toBeInTheDocument();
    expect(within(overview).queryByText("Members")).not.toBeInTheDocument();
  });

  it("lets the creator correct the destinations a draft picked up", async () => {
    // They arrive from the model's reading of a sentence or from a pin on the
    // globe, so the traveller needs to fix them without another chat turn.
    const trip = buildTripResponse("DRAFT");
    const updateDraftTripBrief = vi.fn().mockResolvedValue({
      trip: {
        id: TRIP_ID, name: "New York", nameSource: "AUTO", status: "DRAFT",
        departureCities: ["Singapore"], destinationCandidates: ["New York"],
        travelDateStart: null, travelDateEnd: null, travelDays: 15,
        updatedAt: "2026-09-03T10:00:00.000Z",
      },
    });
    const api = createApi({
      getTrip: vi.fn().mockResolvedValue({
        ...trip,
        trip: { ...trip.trip, departureCities: ["Singapore"], destinationCandidates: ["New York Fun"] },
      }),
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
      updateDraftTripBrief,
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    fireEvent.click(await screen.findByRole("button", { name: "Edit destinations" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Destinations, separated by commas/ }), {
      target: { value: "New York, Boston" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateDraftTripBrief).toHaveBeenCalledWith(TRIP_ID, {
      destinationCandidates: ["New York", "Boston"],
      replaceDestinationCandidates: true,
      titleLocale: "en",
    }));
  });

  it("offers no destination edit once the trip has left DRAFT", async () => {
    // The draft-brief route refuses anything past DRAFT, so an affordance
    // there would only ever produce a failed save.
    const api = createApi({
      getTripThreads: vi.fn().mockResolvedValue({ threads: [buildThread(DEFAULT_THREAD_ID, "Default", true)] }),
    });
    renderWithIntl(<TripWorkspace tripId={TRIP_ID} />, { api });

    expect(await screen.findByText("Trip overview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit destinations" })).not.toBeInTheDocument();
  });
});
