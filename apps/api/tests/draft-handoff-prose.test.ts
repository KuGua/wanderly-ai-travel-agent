import { describe, expect, it } from "vitest";

import { buildDraftHandoffProse } from "../src/providers/llm-gateway.js";
import { personalTripContextSchema } from "../src/skills/personal/personal-trip-context-schema.js";

const baseContext = {
  tripId: "11111111-1111-4111-8111-111111111111",
  tripName: "Tokyo",
  tripStatus: "DRAFT" as const,
  travelDateStart: null,
  travelDateEnd: null,
  travelDays: null,
  departureCities: [],
  destinationCandidates: [],
  canStartSharedPlanning: false,
  missingFields: [] as Array<"departure_city" | "destination_city" | "travel_dates">,
};

function makeContext(overrides: Record<string, unknown>): ReturnType<typeof personalTripContextSchema.parse> {
  return personalTripContextSchema.parse({ ...baseContext, ...overrides });
}

describe("buildDraftHandoffProse", () => {
  it("returns the empty string when no trip context is provided", () => {
    expect(buildDraftHandoffProse(null)).toBe("");
  });

  it("returns the empty string for non-DRAFT trips — handoff prose is DRAFT-only", () => {
    expect(buildDraftHandoffProse(makeContext({
      tripStatus: "PLANNING",
      departureCities: ["Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-10",
      travelDateEnd: "2026-09-15",
      canStartSharedPlanning: false,
    }))).toBe("");
    expect(buildDraftHandoffProse(makeContext({
      tripStatus: "CONFIRMED",
      canStartSharedPlanning: false,
    }))).toBe("");
  });

  it("forbids claiming planning has started and enumerates missing fields when canStartSharedPlanning=false", () => {
    const prose = buildDraftHandoffProse(makeContext({
      tripStatus: "DRAFT",
      departureCities: ["Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: null,
      travelDateEnd: null,
      travelDays: null,
      missingFields: ["travel_dates"],
    }));
    expect(prose).toContain("DRAFT");
    expect(prose).toContain("缺：出行日期");
    expect(prose).toContain("不得声称已开始规划");
    expect(prose).toContain("不得生成逐日行程");
    // The whole point: natural language must not be able to start planning.
    expect(prose).toContain("自然语言不得触发任何共享规划流程");
    expect(prose).toContain("等待用户在界面点击「开始规划」按钮");
    // When not ready, the prose must NOT tell the model planning has begun.
    expect(prose).not.toContain("信息已齐全");
    expect(prose).not.toContain("才会真正进入共享规划");
  });

  it("joins multiple missing fields with the Chinese list separator and shows them all", () => {
    const prose = buildDraftHandoffProse(makeContext({
      tripStatus: "DRAFT",
      departureCities: [],
      destinationCandidates: [],
      travelDateStart: null,
      travelDateEnd: null,
      travelDays: null,
      missingFields: ["departure_city", "destination_city", "travel_dates"],
    }));
    expect(prose).toContain("缺：出发城市、目的地城市、出行日期");
  });

  it("tells the model to wait for the UI CTA when the brief is complete", () => {
    const prose = buildDraftHandoffProse(makeContext({
      tripStatus: "DRAFT",
      departureCities: ["Shanghai"],
      destinationCandidates: ["Tokyo"],
      travelDateStart: "2026-09-10",
      travelDateEnd: "2026-09-15",
      travelDays: null,
      canStartSharedPlanning: true,
      missingFields: [],
    }));
    expect(prose).toContain("信息已齐全");
    expect(prose).toContain("用户点击屏幕上的「开始规划」按钮才会真正进入共享规划");
    expect(prose).toContain("不要替他们点击或代为确认");
    // Even when ready, the prose forbids the model from auto-activating.
    expect(prose).not.toContain("不得声称已开始规划");
  });
});

describe("personalTripContextSchema (DRAFT handoff fields)", () => {
  it("rejects unknown missing-field values so the enum stays closed", () => {
    const result = personalTripContextSchema.safeParse({
      ...baseContext,
      missingFields: ["free_text_brief"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts every documented missing-field value", () => {
    const result = personalTripContextSchema.safeParse({
      ...baseContext,
      missingFields: ["departure_city", "destination_city", "travel_dates"],
    });
    expect(result.success).toBe(true);
  });

  it("caps missingFields at three entries", () => {
    const result = personalTripContextSchema.safeParse({
      ...baseContext,
      missingFields: ["departure_city", "destination_city", "travel_dates", "departure_city"],
    });
    expect(result.success).toBe(false);
  });

  it("requires canStartSharedPlanning to be a boolean (no free-form readiness text)", () => {
    const result = personalTripContextSchema.safeParse({
      ...baseContext,
      canStartSharedPlanning: "ready",
    });
    expect(result.success).toBe(false);
  });
});