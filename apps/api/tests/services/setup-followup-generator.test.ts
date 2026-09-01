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
import { generateSetupFollowup } from "../../src/services/setup-followup-generator.js";
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
