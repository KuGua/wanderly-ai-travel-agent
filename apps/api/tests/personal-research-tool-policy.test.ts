/**
 * The two rules a model-initiated tool call is subject to. Both are about
 * spending someone's money or quota without them asking, so they are worth
 * pinning rather than leaving to the loop's implementation.
 */
import { describe, expect, it } from "vitest";

import {
  TOOL_INVOCATION_MODE,
  ToolCallDeduplicator,
  requiresOwnerConfirmation,
} from "../src/agents/personal-research-tool-policy.js";
import { PERSONAL_RESEARCH_OPERATION_CAPABILITIES } from "../src/config/personal-research-allowed-capabilities.js";

describe("tool invocation mode", () => {
  it("classifies every capability the enum knows about", () => {
    // A capability added later without a mode would otherwise default to
    // undefined and read as "no confirmation needed".
    for (const capability of PERSONAL_RESEARCH_OPERATION_CAPABILITIES) {
      expect(TOOL_INVOCATION_MODE[capability]).toMatch(/^(AUTOMATIC|CONFIRMED)$/);
    }
  });

  it("lets the free geographic reads run on the model's initiative", () => {
    expect(requiresOwnerConfirmation("places.search")).toBe(false);
    expect(requiresOwnerConfirmation("navigation.route")).toBe(false);
    expect(requiresOwnerConfirmation("accommodation.discovery")).toBe(false);
    expect(requiresOwnerConfirmation("hotel.search")).toBe(false);
  });

  /**
   * Flight joined that list on 2026-09-06. It meets the same test — read-only,
   * bounded, deduplicated, unable to book or pay — and its confirmation was
   * unreachable rather than protective: the confirm buttons only appear after
   * a tool call the model never made, so the one way to authorise a flight
   * search was to type 确认搜索机票, which nothing in the product mentions.
   */
  it("lets flight search run without a second confirmation", () => {
    expect(requiresOwnerConfirmation("flight.search")).toBe(false);
  });

  it("keeps explicit confirmation on the remaining gated suppliers", () => {
    expect(requiresOwnerConfirmation("activities.search")).toBe(true);
    expect(requiresOwnerConfirmation("mobility.search")).toBe(true);
  });
});

describe("repeat-call guard", () => {
  it("allows a call once and refuses the identical repeat", () => {
    const guard = new ToolCallDeduplicator();
    const args = { latitude: 35.68, longitude: 139.69, radiusMeters: 1500 };
    expect(guard.claim("places.search", args).duplicate).toBe(false);
    expect(guard.claim("places.search", args).duplicate).toBe(true);
  });

  it("treats different arguments as a refinement, not a repeat", () => {
    const guard = new ToolCallDeduplicator();
    guard.claim("places.search", { radiusMeters: 1500 });
    expect(guard.claim("places.search", { radiusMeters: 3000 }).duplicate).toBe(false);
  });

  it("sees through key order", () => {
    // Two serializations of the same request must not slip past as distinct.
    const guard = new ToolCallDeduplicator();
    guard.claim("flight.search", { originId: "PVG", destinationId: "NRT" });
    expect(guard.claim("flight.search", { destinationId: "NRT", originId: "PVG" }).duplicate).toBe(true);
  });

  it("keeps each tool's history separate", () => {
    const guard = new ToolCallDeduplicator();
    guard.claim("places.search", { q: 1 });
    expect(guard.claim("activities.search", { q: 1 }).duplicate).toBe(false);
  });

  it("does not carry across guards, so a later turn may search again", () => {
    const args = { originId: "PVG" };
    expect(new ToolCallDeduplicator().claim("flight.search", args).duplicate).toBe(false);
    expect(new ToolCallDeduplicator().claim("flight.search", args).duplicate).toBe(false);
  });
});
