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
  sharedPlanningState: "NOT_STARTED" as const,
};

function makeContext(overrides: Record<string, unknown>): ReturnType<typeof personalTripContextSchema.parse> {
  return personalTripContextSchema.parse({ ...baseContext, ...overrides });
}

describe("buildDraftHandoffProse", () => {
  it("returns the empty string when no trip context is provided", () => {
    expect(buildDraftHandoffProse(null)).toBe("");
  });

  /**
   * This block is the prompt's only authoritative signal about the activation
   * boundary, and it used to go empty for every non-DRAFT trip. The model then
   * fell back to the generic rule — "destination and dates are known, so tell
   * them to press Start planning" — about a button that disappears on
   * activation. A traveller whose first run failed was told to press it again
   * for as long as the thread lived.
   */
  const activated = {
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo"],
    travelDateStart: "2026-09-10",
    travelDateEnd: "2026-09-15",
    canStartSharedPlanning: false,
    tripStatus: "PLANNING" as const,
  };

  it("tells the model a run is under way rather than pointing at a vanished button", () => {
    const prose = buildDraftHandoffProse(makeContext({ ...activated, sharedPlanningState: "IN_PROGRESS" }));
    expect(prose).toContain("正在进行中");
    expect(prose).toContain("不要让用户点「开始规划」");
    expect(prose).toContain("不得声称方案已经生成");
  });

  it("names the retry button when a run finished without a plan", () => {
    const prose = buildDraftHandoffProse(makeContext({ ...activated, sharedPlanningState: "NO_PLAN_YET" }));
    expect(prose).toContain("没有产出可用方案");
    expect(prose).toContain("「重新规划」");
    // The failure mode this replaces: directing the traveller to a CTA that
    // only ever renders for a DRAFT trip.
    expect(prose).not.toContain("点「开始规划」按钮");
    expect(prose).toContain("不得声称方案已经生成");
  });

  it("points at the shared surface once a plan exists, and never recites it", () => {
    const prose = buildDraftHandoffProse(makeContext({ ...activated, sharedPlanningState: "PLAN_AVAILABLE" }));
    expect(prose).toContain("共享方案面");
    expect(prose).toContain("不要让用户点「开始规划」");
    expect(prose).toContain("不得复述方案内容");
  });

  it("stays silent for a trip past planning with nothing to say", () => {
    expect(buildDraftHandoffProse(makeContext({
      tripStatus: "CONFIRMED",
      canStartSharedPlanning: false,
      sharedPlanningState: "NOT_STARTED",
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

  it("requires concrete dates rather than treating a season or month as a trip fact", () => {
    expect(prose).toContain("具体出行日期");
    expect(prose).toContain("至少出发日，以及返程日或总天数");
    expect(prose).toContain("重复这一具体日期要求");
    expect(prose).not.toContain("大致月份或季节就够");
  });
});
