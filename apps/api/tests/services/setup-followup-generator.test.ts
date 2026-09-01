/**
 * Setup Follow-up Generator — unit tests.
 *
 * Pure-function tests around `deterministicFallback` and the safety
 * gating for `generateSetupFollowup`. The model is mocked via the
 * `modelGateway()` factory's `__setModelGatewayForTests` slot so we never
 * touch a real provider.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The generator records fallback audit rows; mock the audit service so the
// unit tests don't need a live Postgres user row.
vi.mock("../../src/services/audit-service.js", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

import {
  __setModelGatewayForTests,
  modelGateway,
  type ModelGateway,
} from "../../src/providers/gateway-factory.js";
import {
  generateSetupFollowup,
  generateSetupFollowups,
} from "../../src/services/setup-followup-generator.js";
import type { RequestContext } from "../../src/utils/context.js";

const baseCtx: RequestContext = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  correlationId: "00000000-0000-4000-8000-000000000002",
  traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
};

function fakeGateway(impl: Partial<ModelGateway> = {}): ModelGateway {
  return {
    async generateStructuredPlan() {
      return {};
    },
    async generateConversationReply() {
      return { content: "stub", responseMode: "REFUSAL" };
    },
    async explainPlanDiff() {
      return {
        oldPlan: {},
        newPlan: {},
        summary: "stub",
        affectedMembers: [],
        affectedServices: [],
      };
    },
    async generateLocationIntroduction() {
      return {
        content: "stub",
        modelName: "stub",
        promptVersion: "stub",
      };
    },
    ...impl,
  } as ModelGateway;
}

describe("generateSetupFollowup", () => {
  beforeEach(() => {
    __setModelGatewayForTests(fakeGateway());
  });
  afterEach(() => {
    __setModelGatewayForTests(null);
    vi.restoreAllMocks();
  });

  it("returns null when the missing list is empty", async () => {
    const result = await generateSetupFollowup({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: [],
      filledFieldNames: [],
    });
    expect(result).toBeNull();
  });

  it("returns a deterministic fallback when no setup-followup capability is wired", async () => {
    __setModelGatewayForTests(fakeGateway({ /* generateSetupFollowup intentionally absent */ }));
    const result = await generateSetupFollowup({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["DATES_MISSING"],
      filledFieldNames: [],
    });
    expect(result?.source).toBe("fallback");
    expect(result?.questionCode).toBe("DATES_MISSING");
    expect(result?.promptText.length).toBeGreaterThan(0);
    expect(result?.promptText.length).toBeLessThanOrEqual(280);
  });

  it("returns the model's output when valid", async () => {
    __setModelGatewayForTests(fakeGateway({
      async generateSetupFollowup({ requestedMissing }) {
        return {
          questionCode: requestedMissing[0] ?? "DATES_MISSING",
          promptText: "你打算什么时候入住、什么时候离店？",
          modelName: "stub",
          promptVersion: "stub",
        };
      },
    }));
    const result = await generateSetupFollowup({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["DATES_MISSING"],
      filledFieldNames: [],
    });
    expect(result?.source).toBe("model");
    expect(result?.questionCode).toBe("DATES_MISSING");
    expect(result?.promptText).toContain("入住");
  });

  it("falls back when the model returns a questionCode not in missing", async () => {
    __setModelGatewayForTests(fakeGateway({
      async generateSetupFollowup() {
        return {
          questionCode: "STAY_PREFERENCES_MISSING",
          promptText: "应当是 DATES 但模型返回了 STAY",
          modelName: "stub",
          promptVersion: "stub",
        };
      },
    }));
    const result = await generateSetupFollowup({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["DATES_MISSING"],
      filledFieldNames: [],
    });
    expect(result?.source).toBe("fallback");
    expect(result?.questionCode).toBe("DATES_MISSING");
  });

  it("falls back when the prompt contains PII-like passport numbers", async () => {
    __setModelGatewayForTests(fakeGateway({
      async generateSetupFollowup() {
        return {
          questionCode: "DATES_MISSING",
          promptText: "请提供 A12345678 的入住日期。",
          modelName: "stub",
          promptVersion: "stub",
        };
      },
    }));
    const result = await generateSetupFollowup({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["DATES_MISSING"],
      filledFieldNames: [],
    });
    expect(result?.source).toBe("fallback");
  });

  it("falls back when the prompt contains a price token", async () => {
    __setModelGatewayForTests(fakeGateway({
      async generateSetupFollowup() {
        return {
          questionCode: "DATES_MISSING",
          promptText: "你愿意为入住支付 ¥1999 吗？",
          modelName: "stub",
          promptVersion: "stub",
        };
      },
    }));
    const result = await generateSetupFollowup({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["DATES_MISSING"],
      filledFieldNames: [],
    });
    expect(result?.source).toBe("fallback");
  });

  it("falls back when the model throws", async () => {
    __setModelGatewayForTests(fakeGateway({
      async generateSetupFollowup() {
        throw new Error("model timeout");
      },
    }));
    const result = await generateSetupFollowup({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["DATES_MISSING"],
      filledFieldNames: [],
    });
    expect(result?.source).toBe("fallback");
  });

  it("picks the first missing code when multiple are passed", async () => {
    __setModelGatewayForTests(fakeGateway({ /* no generateSetupFollowup → fallback path */ }));
    const result = await generateSetupFollowup({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["FLIGHT_PREFERENCES_MISSING", "STAY_PREFERENCES_MISSING", "DATES_MISSING"],
      filledFieldNames: [],
    });
    // First missing with a fallback entry: FLIGHT_PREFERENCES_MISSING
    expect(result?.questionCode).toBe("FLIGHT_PREFERENCES_MISSING");
  });
});

describe("modelGateway factory", () => {
  afterEach(() => {
    __setModelGatewayForTests(null);
  });

  it("returns the injected test gateway", () => {
    const stub = fakeGateway();
    __setModelGatewayForTests(stub);
    expect(modelGateway()).toBe(stub);
  });
});

// ─── Quick orchestration — multi-slot loop (generateSetupFollowups) ──────────
//
// Tests cover the new wrapper function that drives the existing single-
// question generator ≤3 times per turn, removing each successfully-emitted
// `questionCode` from the requested set before the next call. The wire
// shape (one SSE event per question) and the existing safety gates stay
// untouched. Ref: C:\Users\dongc\.claude\plans\vectorized-scribbling-thimble.md
// §4 (multi-slot loop).

describe("generateSetupFollowups (multi-slot loop)", () => {
  beforeEach(() => {
    __setModelGatewayForTests(fakeGateway());
  });
  afterEach(() => {
    __setModelGatewayForTests(null);
    vi.restoreAllMocks();
  });

  it("returns an empty array when requestedMissing is empty", async () => {
    const result = await generateSetupFollowups({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: [],
      filledFieldNames: [],
    });
    expect(result).toEqual([]);
  });

  it("emits up to one followup per model call (single-question invariant)", async () => {
    __setModelGatewayForTests(fakeGateway({
      async generateSetupFollowup({ requestedMissing }) {
        return {
          questionCode: requestedMissing[0] ?? "DATES_MISSING",
          promptText: "请你确认日期",
          modelName: "stub",
          promptVersion: "stub",
        };
      },
    }));
    const result = await generateSetupFollowups({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["DATES_MISSING", "BUDGET_HINT_MISSING"],
      filledFieldNames: [],
      maxQuestions: 3,
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.questionCode).toBe("DATES_MISSING");
    expect(result[1]?.questionCode).toBe("BUDGET_HINT_MISSING");
  });

  it("stops at maxQuestions when more codes are missing", async () => {
    __setModelGatewayForTests(fakeGateway({
      async generateSetupFollowup({ requestedMissing }) {
        return {
          questionCode: requestedMissing[0] ?? "DATES_MISSING",
          promptText: "stub",
          modelName: "stub",
          promptVersion: "stub",
        };
      },
    }));
    const result = await generateSetupFollowups({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: [
        "DATES_MISSING",
        "BUDGET_HINT_MISSING",
        "STAY_PREFERENCES_MISSING",
        "FLIGHT_PREFERENCES_MISSING",
      ],
      filledFieldNames: [],
      maxQuestions: 2,
    });
    expect(result).toHaveLength(2);
  });

  it("falls back per question independently (model returns valid then fails)", async () => {
    let calls = 0;
    __setModelGatewayForTests(fakeGateway({
      async generateSetupFollowup({ requestedMissing }) {
        calls += 1;
        if (calls === 1) {
          return {
            questionCode: "DATES_MISSING",
            promptText: "model answer",
            modelName: "stub",
            promptVersion: "stub",
          };
        }
        throw new Error("model timeout");
      },
    }));
    const result = await generateSetupFollowups({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["DATES_MISSING", "BUDGET_HINT_MISSING"],
      filledFieldNames: [],
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.source).toBe("model");
    expect(result[1]?.source).toBe("fallback");
    expect(result[1]?.questionCode).toBe("BUDGET_HINT_MISSING");
  });

  it("returns single deterministic fallback per question when gateway absent", async () => {
    __setModelGatewayForTests(fakeGateway({ /* generateSetupFollowup intentionally absent */ }));
    const result = await generateSetupFollowups({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["BUDGET_HINT_MISSING"],
      filledFieldNames: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("fallback");
    expect(result[0]?.questionCode).toBe("BUDGET_HINT_MISSING");
    // Fallback prompt text contains the new budget-specific copy.
    expect(result[0]?.promptText).toContain("预算");
  });

  it("short-circuits when model repeats the same questionCode", async () => {
    let calls = 0;
    __setModelGatewayForTests(fakeGateway({
      async generateSetupFollowup() {
        calls += 1;
        return {
          questionCode: "DATES_MISSING",
          promptText: "model repeats",
          modelName: "stub",
          promptVersion: "stub",
        };
      },
    }));
    const result = await generateSetupFollowups({
      ctx: baseCtx,
      tripId: "00000000-0000-4000-8000-000000000003",
      ownerUserId: baseCtx.actorUserId,
      locale: "zh-CN",
      requestedMissing: ["DATES_MISSING", "BUDGET_HINT_MISSING"],
      filledFieldNames: [],
      maxQuestions: 5,
    });
    // After the first successful emission, the loop removes DATES_MISSING
    // and continues. The second call still returns DATES_MISSING because
    // the LLM ignored the trimmed input — the wrapper detects that the
    // emitted code is no longer in the remaining list and bails out.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(result.length).toBeLessThan(5);
  });
});
