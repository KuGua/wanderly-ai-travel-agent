import { describe, expect, it } from "vitest";

import {
  explainMemoryObservation,
  memoryEpisodeId,
  memoryObservationFor,
  parseMemoryObservationPayload,
} from "../src/services/memory-observation-bridge.js";

describe("memoryObservationFor", () => {
  it("unwraps the four constraint fields memory models", () => {
    expect(memoryObservationFor("no_red_eye", { enabled: true }))
      .toEqual({ fieldKey: "no_red_eye", value: true });
    expect(memoryObservationFor("accommodation_style", { style: "budget" }))
      .toEqual({ fieldKey: "accommodation_style", value: "budget" });
    expect(memoryObservationFor("interests", { topics: ["food", "art"] }))
      .toEqual({ fieldKey: "interests", value: ["food", "art"] });
  });

  it("renames travel_pace to the memory catalog's trip_pace", () => {
    // The two catalogs named the same concept differently; a silent mismatch
    // would drop every pace observation.
    expect(memoryObservationFor("travel_pace", { pace: "packed" }))
      .toEqual({ fieldKey: "trip_pace", value: "packed" });
  });

  it("produces nothing for a constraint memory does not model", () => {
    expect(memoryObservationFor("budget_max", { amount: 100 })).toBeNull();
    expect(memoryObservationFor("departure_city", { city: "Shanghai" })).toBeNull();
    expect(memoryObservationFor("accessibility_need", { note: "step-free" })).toBeNull();
  });

  it("produces nothing for a value the constraint catalog allows but memory does not", () => {
    // The constraint catalog accepts `boutique`; the memory catalog's enum
    // stops at three styles. The bridge hands it over and `observeBehavior`
    // rejects it — it must not throw inside the confirmation transaction.
    expect(memoryObservationFor("accommodation_style", { style: "boutique" }))
      .toEqual({ fieldKey: "accommodation_style", value: "boutique" });
  });

  it("produces nothing for a malformed constraint value", () => {
    expect(memoryObservationFor("trip_pace", null)).toBeNull();
    expect(memoryObservationFor("accommodation_style", {})).toBeNull();
    expect(memoryObservationFor("accommodation_style", ["budget"])).toBeNull();
  });
});

describe("memoryEpisodeId", () => {
  const base = {
    tripId: "trip-1",
    fieldKey: "trip_pace",
    ownerUserId: "user-1",
    value: "packed",
  };

  it("is stable for the same decision", () => {
    expect(memoryEpisodeId(base)).toBe(memoryEpisodeId(base));
  });

  it("carries no timestamp, so re-confirming the same value is one episode", () => {
    // Independence comes from the id, never elapsed time: a member cannot
    // manufacture a habit by toggling a setting back and forth in one trip.
    const id = memoryEpisodeId(base);
    expect(id).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(memoryEpisodeId({ ...base })).toBe(id);
  });

  it("separates trips, fields, owners and values", () => {
    const id = memoryEpisodeId(base);
    expect(memoryEpisodeId({ ...base, tripId: "trip-2" })).not.toBe(id);
    expect(memoryEpisodeId({ ...base, fieldKey: "accommodation_style" })).not.toBe(id);
    expect(memoryEpisodeId({ ...base, ownerUserId: "user-2" })).not.toBe(id);
    expect(memoryEpisodeId({ ...base, value: "relaxed" })).not.toBe(id);
  });

  it("never embeds the confirmed value in the clear", () => {
    // The id lands in an outbox payload and an idempotency key, both of which
    // outlive the proposal.
    expect(memoryEpisodeId(base)).not.toContain("packed");
  });
});

describe("parseMemoryObservationPayload", () => {
  const payload = {
    userId: "u", tripId: "t", fieldKey: "trip_pace",
    value: "packed", episodeId: "e", observedAt: "2026-08-01T00:00:00.000Z",
  };

  it("round-trips a well-formed payload", () => {
    expect(parseMemoryObservationPayload(payload)).toEqual(payload);
  });

  it("rejects a row missing any identifier", () => {
    for (const key of ["userId", "tripId", "fieldKey", "episodeId", "observedAt"]) {
      expect(parseMemoryObservationPayload({ ...payload, [key]: undefined })).toBeNull();
    }
    expect(parseMemoryObservationPayload(null)).toBeNull();
    expect(parseMemoryObservationPayload("nope")).toBeNull();
  });
});

/**
 * The three skip reasons exist so a caller that got the value shape wrong is
 * distinguishable from the designed no-op. Before this, a seed passing
 * `"relaxed"` where `{ pace: "relaxed" }` was required wrote nothing, threw
 * nothing and logged nothing — indistinguishable from success.
 */
describe("explainMemoryObservation", () => {
  it("names the designed no-op for a field the memory catalog does not track", () => {
    expect(explainMemoryObservation("budget_max", { amount: 100 }))
      .toEqual({ candidate: null, skipReason: "not_in_catalog" });
  });

  it("separates a caller passing a bare value from a tracked field", () => {
    expect(explainMemoryObservation("travel_pace", "relaxed"))
      .toEqual({ candidate: null, skipReason: "value_not_an_object" });
    expect(explainMemoryObservation("travel_pace", ["relaxed"]))
      .toEqual({ candidate: null, skipReason: "value_not_an_object" });
  });

  it("separates a right-shaped object whose key the mapping does not read", () => {
    expect(explainMemoryObservation("travel_pace", { tempo: "relaxed" }))
      .toEqual({ candidate: null, skipReason: "value_shape_mismatch" });
  });

  it("reports no skip reason on the path that produces an observation", () => {
    const outcome = explainMemoryObservation("travel_pace", { pace: "relaxed" });
    expect(outcome.skipReason).toBeNull();
    expect(outcome.candidate).toEqual({ fieldKey: "trip_pace", value: "relaxed" });
  });
});
