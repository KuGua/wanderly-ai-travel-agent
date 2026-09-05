import { describe, expect, it } from "vitest";

import { buildDraftHandoffProse, CONVERSATION_PROMPT_PROSE } from "../src/providers/llm-gateway.js";
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
/**
 * The static prose and the injected DRAFT handoff block are read by the model
 * in the same breath, so they must not disagree — and a disagreement between
 * them is invisible to every test that exercises only one of the two.
 *
 * One did ship. The static rules said 「目的地是唯一的硬前提」 and, once a
 * destination was known, 「不要再问任何东西，直接说可以开始规划」. The handoff
 * block says the opposite whenever `canStartSharedPlanning` is false — which
 * is exactly the case where a destination is set but the departure date is
 * not. The model followed the static line and announced it was entering the
 * planning stage, on a trip whose "Start planning" button was not even
 * rendered, and nothing happened.
 *
 * Readiness has one authority: the handoff block, derived from the same
 * predicate as the UI's CTA. The prose may say how to ask; it may not decide
 * whether planning can begin, and it may never claim planning has started.
 */
describe("conversation prose defers to the DRAFT handoff block", () => {
  const prose = CONVERSATION_PROMPT_PROSE;

  it("never tells the model to announce that planning can start or has started", () => {
    for (const banned of ["直接说可以开始规划", "说可以开始编排了"]) {
      expect(prose, `prose still contains "${banned}"`).not.toContain(banned);
    }
  });

  it("does not name a prerequisite of its own", () => {
    // `missingFields` carries departure city and dates too, so any rule
    // calling the destination the only one contradicts it.
    expect(prose).not.toContain("目的地是唯一的硬前提");
  });

  it("points at the handoff block as the authority on readiness", () => {
    expect(prose).toContain("canStartSharedPlanning");
    expect(prose).toContain("missingFields");
  });
});
