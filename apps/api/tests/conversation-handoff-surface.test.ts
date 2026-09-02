import { describe, expect, it } from "vitest";

import { shouldExtractConversationHandoff } from "../src/tasks/handlers/conversation-task-handler.js";

/**
 * Exploration must not feed long-term memory.
 *
 * Nothing about the trip row separates the two surfaces — the first message
 * typed on the globe creates a DRAFT trip that is listed and openable straight
 * away, so the same trip is reachable from both. The turn carries where it was
 * typed, and this gate is the only thing that reads it.
 */
describe("shouldExtractConversationHandoff", () => {
  it("extracts from a trip workspace turn on a planning trip", () => {
    expect(shouldExtractConversationHandoff("MODEL", "PLANNING", "TRIP_WORKSPACE")).toBe(true);
    expect(shouldExtractConversationHandoff("MODEL", "STALE", "TRIP_WORKSPACE")).toBe(true);
  });

  it("never extracts from the exploration globe, whatever the trip status", () => {
    for (const status of ["DRAFT", "PLANNING", "STALE"] as const) {
      expect(shouldExtractConversationHandoff("MODEL", status, "EXPLORE")).toBe(false);
    }
  });

  it("treats an unknown surface as exploration, so an old client remembers nothing", () => {
    expect(shouldExtractConversationHandoff("MODEL", "PLANNING", null)).toBe(false);
    expect(shouldExtractConversationHandoff("MODEL", "PLANNING", undefined)).toBe(false);
    expect(shouldExtractConversationHandoff("MODEL", "PLANNING", "anything-else")).toBe(false);
  });

  it("still refuses a refusal or fallback reply from either surface", () => {
    expect(shouldExtractConversationHandoff("SAFE_REFUSAL", "PLANNING", "TRIP_WORKSPACE")).toBe(false);
    expect(shouldExtractConversationHandoff("FALLBACK", "PLANNING", "TRIP_WORKSPACE")).toBe(false);
  });

  it("does not yet extract from a DRAFT trip workspace turn", () => {
    // Opening this is a product decision, not a code one: docs/
    // personal-and-planning-boundaries.md §5 forbids constraint facts while a
    // trip is DRAFT, and confirming a candidate writes one.
    expect(shouldExtractConversationHandoff("MODEL", "DRAFT", "TRIP_WORKSPACE")).toBe(false);
  });
});
