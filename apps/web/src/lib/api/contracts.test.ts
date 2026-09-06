import { describe, expect, it } from "vitest";

import {
  agentRunResponseSchema,
  agentStreamEventSchema,
  conversationTurnAcceptedResponseSchema,
  explorationStartResponseSchema,
  locationReferenceResponseSchema,
  latestPlanResponseSchema,
  latestPlanSummarySchema,
  ownerConversationResponseSchema,
  profileResponseSchema,
  researchResultSchema,
  serviceGapSchema,
  tripsResponseSchema,
} from "./contracts";
import { testProfileResponse, testTripsResponse } from "@/test/api-fixtures";

describe("API contracts", () => {
  it("accepts a latest plan awaiting votes", () => {
    expect(latestPlanSummarySchema.parse({
      id: "66666666-6666-4666-8666-666666666666",
      version: 5,
      status: "PROPOSED",
      generatedAt: "2026-09-06T10:35:00.000Z",
    }).status).toBe("PROPOSED");
  });

  it("accepts the canonical nullable Profile and Trip fixture shapes", () => {
    expect(profileResponseSchema.parse(testProfileResponse)).toEqual(testProfileResponse);
    expect(tripsResponseSchema.parse(testTripsResponse)).toEqual(testTripsResponse);
  });

  it("accepts a durable planning run completed with non-authoritative provider gaps", () => {
    const run = agentRunResponseSchema.parse({
      runId: "55555555-5555-4555-8555-555555555555",
      operation: "PLAN",
      status: "COMPLETED_WITH_GAPS",
      generationAttempt: 1,
      attemptCount: 1,
      createdAt: "2026-08-31T10:00:00.000Z",
      updatedAt: "2026-08-31T10:00:10.000Z",
      finishedAt: "2026-08-31T10:00:10.000Z",
      errorCode: null,
      assistantMessageId: null,
      resultPlanId: "66666666-6666-4666-8666-666666666666",
      researchIntentDraft: null,
      researchIntentState: null,
    });

    expect(run.status).toBe("COMPLETED_WITH_GAPS");
  });

  it("accepts a grounded flight plan when optional stay and ground evidence are unavailable", () => {
    const response = latestPlanResponseSchema.parse({
      plan: {
        id: "66666666-6666-4666-8666-666666666666",
        version: 1,
        planData: {
          destination: "LIS",
          destinationCandidatesEvaluated: ["NRT", "LIS"],
          flights: [{
            id: "offer-1",
            providerOfferId: "provider-offer-1",
            providerName: "serpapi",
            queryId: "77777777-7777-4777-8777-777777777777",
            origin: "SIN",
            destination: "LIS",
            segments: [{
              carrierCode: "SQ",
              flightNumber: "SQ000",
              origin: "SIN",
              destination: "LIS",
              departureAt: "2026-10-10T10:00:00+08:00",
              arrivalAt: "2026-10-10T18:00:00+01:00",
              duration: "PT15H",
            }],
            totalDuration: "PT15H",
            totalPrice: 1200,
            currency: "USD",
            cabin: "ECONOMY",
            adults: 1,
            baggageSummary: null,
            changeSummary: null,
            source: "serpapi",
            capturedAt: "2026-08-31T10:00:00.000Z",
            expiresAt: "2026-08-31T10:15:00.000Z",
          }],
          generatedAt: "2026-08-31T10:00:00.000Z",
        },
      },
    });

    expect(response.plan.planData.stays).toEqual([]);
    expect(response.plan.planData.ground).toEqual([]);
  });

  it("rejects a Profile missing canonical fields", () => {
    expect(() => profileResponseSchema.parse({
      profile: { id: "not-enough-fields", displayName: "Traveler" },
    })).toThrow();
  });

  it("rejects unconfirmed Trip dashboard fields in place of the canonical contract", () => {
    expect(() => tripsResponseSchema.parse({
      trips: [{
        id: "44444444-4444-4444-8444-444444444444",
        name: "Asia Trip",
        status: "PLANNING",
        latestPlanStatus: "STALE",
        actionRequired: true,
      }],
    })).toThrow();
  });

  it("accepts only an explicitly non-authoritative location reference", () => {
    expect(locationReferenceResponseSchema.parse({
      outcome: "REFERENCE",
      country: "Portugal",
      countryCode: "PT",
      admin1: "Lisbon",
      admin1Code: "PT-11",
      nearestCity: "Lisbon",
      nearestCityCoordinates: { latitude: 38.7167, longitude: -9.1333 },
      distanceKm: 0,
      source: "Natural Earth + GeoNames",
      datasetVersion: "2026-08-demo.1",
      checkedAt: "2026-08-25T00:00:00.000Z",
      isTravelFact: false,
    }).isTravelFact).toBe(false);
  });

  it("accepts a DRAFT exploration start response and rejects a prematurely planning Trip", () => {
    const response = {
      trip: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Untitled exploration",
        status: "DRAFT",
        departureCities: [],
        destinationCandidates: [],
        travelDateStart: null,
        travelDateEnd: null,
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
      defaultThread: {
        id: "11111111-1111-4111-8111-111111111111",
        tripId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        scope: "TRIP",
        isDefault: true,
      },
    };

    expect(explorationStartResponseSchema.parse(response).trip.status).toBe("DRAFT");
    expect(() => explorationStartResponseSchema.parse({
      ...response,
      trip: { ...response.trip, status: "PLANNING" },
    })).toThrow();
  });

  it("accepts owner conversation history and current MODEL/SAFE_REFUSAL modes only", () => {
    const thread = {
      id: "11111111-1111-4111-8111-111111111111",
      ownerUserId: "22222222-2222-4222-8222-222222222222",
      tripId: "99999999-9999-4999-8999-999999999999",
      scope: "TRIP",
      isDefault: false,
      title: "Explore conversation",
      titleSource: "AUTO",
      titleLocale: "en",
      titleUpdatedAt: null,
      createdAt: "2026-08-25T10:00:00.000Z",
      archivedAt: null,
    };
    const userMessage = {
      id: "33333333-3333-4333-8333-333333333333",
      role: "USER",
      content: "Tell me about Tokyo",
      sequence: 1,
      createdAt: "2026-08-25T10:00:00.000Z",
    };
    const assistantMessage = {
      id: "44444444-4444-4444-8444-444444444444",
      role: "ASSISTANT",
      content: "General guidance",
      sequence: 2,
      createdAt: "2026-08-25T10:00:01.000Z",
    };

    expect(ownerConversationResponseSchema.parse({ thread, messages: [userMessage, assistantMessage] })).toBeDefined();
    expect(conversationTurnAcceptedResponseSchema.parse({
      threadId: thread.id,
      runId: "55555555-5555-4555-8555-555555555555",
      operation: "CONVERSATION",
      status: "QUEUED",
      generationAttempt: 0,
      userMessage,
    }).status).toBe("QUEUED");

    expect(agentStreamEventSchema.parse({
      event: "message.delta",
      runId: "55555555-5555-4555-8555-555555555555",
      generationAttempt: 1,
      sequence: 0,
      delta: "General ",
    }).event).toBe("message.delta");
    expect(() => agentStreamEventSchema.parse({
      event: "message.delta",
      runId: "55555555-5555-4555-8555-555555555555",
      generationAttempt: 1,
      sequence: -1,
      delta: "invalid",
    })).toThrow();
  });

  /**
   * Regression for the 2026-09-05 planning-run detail page, which showed
   * "Unable to load the planning result" for a run that had completed. The
   * failure was on this side of the wire: the capability mirror omitted
   * `places` and `readiness`, so a response carrying a `places` gap failed
   * the parse and the page reported a transport error for a run whose
   * outcome it was holding in its hands.
   */
  it("mirrors every service-gap capability and code the API can emit", () => {
    for (const capability of [
      "flight", "stay", "hotel", "accommodation", "activities",
      "places", "navigation", "transit", "mobility", "readiness",
    ]) {
      expect(serviceGapSchema.parse({ capability, code: "NO_RESULTS" }).capability).toBe(capability);
    }
    for (const code of [
      "NOT_CONFIGURED", "SEARCH_CONSTRAINTS_INCOMPLETE", "NO_RESULTS", "RATE_LIMITED",
      "UPSTREAM_TIMEOUT", "UPSTREAM_FAILURE", "INVALID_PROVIDER_RESPONSE",
      "PROVIDER_NOT_APPROVED", "PROVIDER_REQUEST_REJECTED", "SKILL_CONTRACT_VIOLATION",
    ]) {
      expect(serviceGapSchema.parse({ capability: "places", code }).code).toBe(code);
    }
    expect(() => serviceGapSchema.parse({ capability: "weather", code: "NO_RESULTS" })).toThrow();
  });

  /**
   * The payload trip 8a634324 actually produced on 2026-09-05, byte for byte
   * from `planning_research_results` plus the `offers: []` both research
   * endpoints always send. The mirror was `.strict()` without `offers`, so
   * every response from either endpoint was rejected: the shared-plan gaps
   * panel lost its capability list, and the planning-run detail page showed
   * "unable to load the planning result" for a run it had already received.
   */
  it("accepts a real completed-with-gaps research payload", () => {
    const research = {
      id: "a15c905b-b80d-4980-84b8-7c2d04c7c970",
      tripId: "8a634324-3831-43d2-894f-ebaf61c3f021",
      snapshotId: "cc0945b9-c4da-4b42-a0f8-5eadf702bb3a",
      agentTaskRunId: "4b507761-de01-47fd-a4bf-a5e565faac5b",
      status: "COMPLETED_WITH_GAPS",
      serviceGaps: [
        { code: "SKILL_CONTRACT_VIOLATION", capability: "accommodation" },
        { code: "SKILL_CONTRACT_VIOLATION", capability: "places" },
        { code: "PROVIDER_REQUEST_REJECTED", capability: "flight", destinationId: "Shanghai" },
      ],
      resultPlanId: null,
      offers: [{
        category: "hotel",
        providerName: "OpenTripMap",
        title: "Jinjiang Hotel",
        price: null,
        rating: null,
        detail: null,
        capturedAt: "2026-09-05T07:53:18.793Z",
      }],
      createdAt: "2026-09-05T07:53:21.205Z",
    };

    const parsed = researchResultSchema.parse(research);
    expect(parsed.serviceGaps).toHaveLength(3);
    expect(parsed.offers).toHaveLength(1);
  });
});
