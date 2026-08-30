import { describe, expect, it } from "vitest";
import {
  personalResearchCapabilitySchema,
  personalResearchIntentSchema,
  personalResearchKindSchema,
  researchCommandAcceptedResponseSchema,
  researchCommandRequestSchema,
  researchIntentExtractedEventSchema,
  researchStageEventSchema,
  researchStageSchema,
  uuidSchema,
} from "../../src/types/schemas";

describe("research command contract", () => {
  it("accepts a minimal RESEARCH_ONLY intent", () => {
    const parsed = personalResearchIntentSchema.parse({
      kind: "RESEARCH_ONLY",
      requestedCapabilities: ["activities", "places"],
    });
    expect(parsed.kind).toBe("RESEARCH_ONLY");
    expect(parsed.requestedCapabilities).toHaveLength(2);
    expect(parsed.destinationCandidates).toBeUndefined();
  });

  it("accepts a PROPOSE_PLAN intent with destination candidates", () => {
    const parsed = personalResearchIntentSchema.parse({
      kind: "PROPOSE_PLAN",
      requestedCapabilities: ["flight", "hotel", "places"],
      destinationCandidates: ["Tokyo"],
    });
    expect(parsed.kind).toBe("PROPOSE_PLAN");
    expect(parsed.destinationCandidates).toEqual(["Tokyo"]);
  });

  it("rejects intent without capabilities", () => {
    expect(() =>
      personalResearchIntentSchema.parse({
        kind: "RESEARCH_ONLY",
        requestedCapabilities: [],
      }),
    ).toThrow();
  });

  it("rejects intent with an unknown capability", () => {
    expect(() =>
      personalResearchIntentSchema.parse({
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["flight", "weather"],
      }),
    ).toThrow();
  });

  it("rejects intent with too many destination candidates", () => {
    expect(() =>
      personalResearchIntentSchema.parse({
        kind: "PROPOSE_PLAN",
        requestedCapabilities: ["flight"],
        destinationCandidates: ["A", "B", "C", "D", "E", "F"],
      }),
    ).toThrow();
  });

  it("rejects intent with unknown keys (snapshotId / provider / coordinates / dates / identity / chat)", () => {
    const base = { kind: "RESEARCH_ONLY", requestedCapabilities: ["activities"] };
    for (const forbidden of [
      { snapshotId: uuidSchema.parse("00000000-0000-0000-0000-000000000000") },
      { provider: "amadeus" },
      { latitude: 35.6, longitude: 139.7 },
      { address: "1-1-1 Shibuya" },
      { placeId: "ChIJ..." },
      { dates: { start: "2026-01-01", end: "2026-01-08" } },
      { departureDate: "2026-01-01", returnDate: "2026-01-08" },
      { currency: "JPY", adults: 1, cabin: "ECONOMY" },
      { identity: { userId: "u", tripId: "t" } },
      { question: "find me a hotel" },
    ]) {
      expect(() => personalResearchIntentSchema.parse({ ...base, ...forbidden })).toThrow(
        /unrecognized|Unknown|invalid/,
      );
    }
  });

  it("exposes only the documented capability enum members", () => {
    expect(personalResearchCapabilitySchema.options).toEqual([
      "flight",
      "accommodation",
      "hotel",
      "activities",
      "places",
      "navigation",
      "mobility",
      "readiness",
    ]);
  });

  it("exposes only RESEARCH_ONLY and PROPOSE_PLAN kinds", () => {
    expect(personalResearchKindSchema.options).toEqual(["RESEARCH_ONLY", "PROPOSE_PLAN"]);
  });

  it("accepts a happy-path research command request", () => {
    const parsed = researchCommandRequestSchema.parse({
      requestId: "00000000-0000-0000-0000-000000000000",
      outputMode: "RESEARCH_ONLY",
      requestedCapabilities: ["activities", "places"],
    });
    expect(parsed.outputMode).toBe("RESEARCH_ONLY");
  });

  it.each([
    ["snapshotId"],
    ["provider"],
    ["toolCallId"],
    ["latitude"],
    ["longitude"],
    ["address"],
    ["placeId"],
    ["dates"],
    ["currency"],
    ["question"],
    ["prompt"],
  ])("rejects a request body carrying %s", (forbidden) => {
    const base = {
      requestId: "00000000-0000-0000-0000-000000000000",
      outputMode: "PROPOSE_PLAN",
      requestedCapabilities: ["flight"],
    };
    expect(() => researchCommandRequestSchema.parse({ ...base, [forbidden]: "x" })).toThrow();
  });

  it("accepts the 202 envelope", () => {
    const parsed = researchCommandAcceptedResponseSchema.parse({
      runId: "00000000-0000-0000-0000-000000000000",
      operation: "RESEARCH",
      snapshotId: "00000000-0000-0000-0000-000000000000",
      status: "QUEUED",
    });
    expect(parsed.operation).toBe("RESEARCH");
    expect(parsed.status).toBe("QUEUED");
  });

  it("rejects the 202 envelope when status is not QUEUED", () => {
    expect(() =>
      researchCommandAcceptedResponseSchema.parse({
        runId: "00000000-0000-0000-0000-000000000000",
        operation: "RESEARCH",
        snapshotId: "00000000-0000-0000-0000-000000000000",
        status: "RUNNING",
      }),
    ).toThrow();
  });

  it("enumerates the 8 research stages exactly", () => {
    expect(researchStageSchema.options).toEqual([
      "SNAPSHOT_CREATED",
      "RESEARCHING",
      "VALIDATING",
      "PERSISTING",
      "COMPLETED",
      "COMPLETED_WITH_GAPS",
      "FAILED",
      "STALE",
    ]);
  });

  it("accepts a research.stage event", () => {
    const parsed = researchStageEventSchema.parse({
      runId: "00000000-0000-0000-0000-000000000000",
      generationAttempt: 0,
      event: "research.stage",
      stage: "SNAPSHOT_CREATED",
    });
    expect(parsed.stage).toBe("SNAPSHOT_CREATED");
  });

  it("rejects a research.stage event with an unknown stage", () => {
    expect(() =>
      researchStageEventSchema.parse({
        runId: "00000000-0000-0000-0000-000000000000",
        generationAttempt: 0,
        event: "research.stage",
        stage: "RETRYING",
      }),
    ).toThrow();
  });

  it("accepts a research.intent_extracted event carrying the draft", () => {
    const parsed = researchIntentExtractedEventSchema.parse({
      runId: "00000000-0000-0000-0000-000000000000",
      generationAttempt: 0,
      event: "research.intent_extracted",
      intent: {
        kind: "PROPOSE_PLAN",
        requestedCapabilities: ["activities", "places"],
        destinationCandidates: ["Tokyo"],
      },
    });
    expect(parsed.intent.kind).toBe("PROPOSE_PLAN");
  });

  it("rejects a research.intent_extracted event when intent leaks authority fields", () => {
    expect(() =>
      researchIntentExtractedEventSchema.parse({
        runId: "00000000-0000-0000-0000-000000000000",
        generationAttempt: 0,
        event: "research.intent_extracted",
        intent: {
          kind: "PROPOSE_PLAN",
          requestedCapabilities: ["activities"],
          snapshotId: "00000000-0000-0000-0000-000000000000",
        },
      }),
    ).toThrow();
  });
});