import { describe, expect, it } from "vitest";

import {
  agentStreamEventSchema,
  conversationTurnAcceptedResponseSchema,
  locationReferenceResponseSchema,
  ownerConversationResponseSchema,
  profileResponseSchema,
  tripsResponseSchema,
} from "./contracts";
import { testProfileResponse, testTripsResponse } from "@/test/api-fixtures";

describe("API contracts", () => {
  it("accepts the canonical nullable Profile and Trip fixture shapes", () => {
    expect(profileResponseSchema.parse(testProfileResponse)).toEqual(testProfileResponse);
    expect(tripsResponseSchema.parse(testTripsResponse)).toEqual(testTripsResponse);
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

  it("accepts owner conversation history and current MODEL/SAFE_REFUSAL modes only", () => {
    const thread = {
      id: "11111111-1111-4111-8111-111111111111",
      ownerUserId: "22222222-2222-4222-8222-222222222222",
      tripId: "99999999-9999-4999-8999-999999999999",
      scope: "TRIP",
      isDefault: false,
      title: "Explore conversation",
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
});
