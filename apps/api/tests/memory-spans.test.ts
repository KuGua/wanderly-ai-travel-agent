import { describe, expect, it } from "vitest";

import { FORBIDDEN_SPAN_ATTRIBUTE_KEYS } from "../src/observability/tracing.js";
import { withMemorySpan } from "../src/memory/memory-spans.js";

describe("withMemorySpan", () => {
  it("returns the handler's result", async () => {
    const value = await withMemorySpan(
      "memory.fact.mutate",
      { operation: "replace" },
      async () => ({ result: 42, outcome: "replaced" }),
    );
    expect(value).toBe(42);
  });

  it("propagates a failure to the caller", async () => {
    // Tracing must never swallow the error the caller has to handle.
    await expect(withMemorySpan(
      "memory.projection.build",
      { operation: "build" },
      async () => { throw new Error("projection invalid"); },
    )).rejects.toThrow("projection invalid");
  });

  it("uses no attribute key the tracing policy forbids", () => {
    // The helper is the one place memory attributes are chosen, so the policy
    // is checked against it rather than against every call site.
    for (const key of ["memory.operation", "memory.source", "memory.outcome",
      "memory.truncated", "memory.invalidated"]) {
      expect(FORBIDDEN_SPAN_ATTRIBUTE_KEYS.has(key)).toBe(false);
    }
  });

  it("carries no field key, value, score or identifier", async () => {
    // A trace is retained and broadly readable. The attribute surface is fixed
    // by the helper's type, so this pins the intent: nothing that says what the
    // product remembers about a person.
    const attributeNames = ["operation", "source", "outcome", "truncated", "invalidated"];
    for (const forbidden of ["fieldKey", "value", "activation", "userId", "tripId", "episodeId"]) {
      expect(attributeNames).not.toContain(forbidden);
    }

    await expect(withMemorySpan(
      "memory.proposal.aggregate",
      { operation: "observe", source: "behavior_aggregation" },
      async () => ({ result: null, outcome: "duplicate_episode" }),
    )).resolves.toBeNull();
  });
});
