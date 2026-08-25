import { describe, expect, it } from "vitest";

import {
  conversationTurnResponseSchema,
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

  it("accepts owner conversation history and current MODEL/SAFE_REFUSAL modes only", () => {
    const thread = {
      id: "11111111-1111-4111-8111-111111111111",
      ownerUserId: "22222222-2222-4222-8222-222222222222",
      tripId: null,
      title: "Explore conversation",
      createdAt: "2026-08-25T10:00:00.000Z",
      archivedAt: null,
    };
    const userMessage = {
      id: "33333333-3333-4333-8333-333333333333",
      role: "USER",
      content: "Tell me about Tokyo",
      createdAt: "2026-08-25T10:00:00.000Z",
    };
    const assistantMessage = {
      id: "44444444-4444-4444-8444-444444444444",
      role: "ASSISTANT",
      content: "General guidance",
      createdAt: "2026-08-25T10:00:01.000Z",
    };

    expect(ownerConversationResponseSchema.parse({ thread, messages: [userMessage, assistantMessage] })).toBeDefined();
    expect(conversationTurnResponseSchema.parse({
      threadId: thread.id,
      userMessage,
      assistantMessage,
      responseMode: "SAFE_REFUSAL",
    }).responseMode).toBe("SAFE_REFUSAL");
    expect(() => conversationTurnResponseSchema.parse({
      threadId: thread.id,
      userMessage,
      assistantMessage,
      responseMode: "DEMO_FALLBACK",
    })).toThrow();
  });
});
