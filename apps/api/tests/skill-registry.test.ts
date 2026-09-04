import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import { __resetRegistryForTests, registerSkill, invokeSkill } from "../src/agents/skill-registry.js";
import { SkillError } from "../src/agents/errors.js";
import type { Skill } from "../src/agents/contracts.js";
import { createRequestContext } from "../src/utils/context.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { metrics } from "../src/observability/metrics.js";

const echoInput = z.object({ v: z.number() });
const echoOutput = z.object({ doubled: z.number() });

function buildEchoSkill(version = "1.0.0"): Skill<{ v: number }, { doubled: number }> {
  return {
    name: `echo.${version}`,
    agent: "personal",
    version,
    allowedTools: ["profile:read"],
    timeoutMs: 1000,
    needsConfirm: false,
    input: echoInput,
    output: echoOutput,
    async handler(_ctx, input) {
      return { doubled: input.v * 2 };
    },
  };
}

function buildSlowSkill(): Skill<unknown, unknown> {
  return {
    name: "slow.skill",
    agent: "personal",
    version: "1.0.0",
    allowedTools: ["profile:read"],
    timeoutMs: 50,
    needsConfirm: false,
    input: z.unknown(),
    output: z.unknown(),
    async handler() {
      await new Promise(resolve => setTimeout(resolve, 200));
      return { ok: true };
    },
  };
}

function buildBadOutputSkill(): Skill<unknown, unknown> {
  return {
    name: "bad.output",
    agent: "personal",
    version: "1.0.0",
    allowedTools: ["profile:read"],
    timeoutMs: 1000,
    needsConfirm: false,
    input: z.unknown(),
    output: z.object({ required: z.string() }),
    async handler() {
      return { unrelated: true };
    },
  };
}

describe("skill registry", () => {
  beforeEach(() => {
    __resetRegistryForTests();
    metrics.reset();
  });

  it("invokes a skill and records success", async () => {
    const skill = buildEchoSkill("1.0.0");
    registerSkill(skill);

    const result = await invokeSkill(skill.name, {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, { v: 2 });

    expect(result).toEqual({ doubled: 4 });
    expect(metrics.render()).toContain('agent_skill_runs_total{agent="personal",outcome="success",skill="other"} 1');
    expect(metrics.render()).toContain('agent_skill_duration_ms_count{agent="personal",outcome="success",skill="other"} 1');
  });

  it("allows the same skill version across independent invocations", async () => {
    const skill = buildEchoSkill("1.0.0");
    registerSkill(skill);

    await expect(invokeSkill(skill.name, {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, { v: 1 })).resolves.toEqual({ doubled: 2 });
    await expect(invokeSkill(skill.name, {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, { v: 2 })).resolves.toEqual({ doubled: 4 });
  });

  it("rejects an expected version mismatch before handler execution", async () => {
    let handlerCalls = 0;
    const skill = buildEchoSkill("1.0.0");
    skill.handler = async (_ctx, input) => {
      handlerCalls += 1;
      return { doubled: input.v * 2 };
    };
    registerSkill(skill);

    await expect(invokeSkill(skill.name, {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, { v: 1 }, {
      expectedVersion: "0.9.0",
    })).rejects.toMatchObject({ code: "SKILL_VERSION_MISMATCH", statusCode: 409 });
    expect(handlerCalls).toBe(0);
  });

  it("rejects unknown skills", async () => {
    await expect(invokeSkill("nope", {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, { v: 1 })).rejects.toBeInstanceOf(SkillError);
  });

  it("enforces timeout", async () => {
    const skill = buildSlowSkill();
    registerSkill(skill);

    await expect(invokeSkill(skill.name, {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, undefined)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(metrics.render()).toContain('agent_skill_runs_total{agent="personal",outcome="timeout",skill="other"} 1');
  });

  it("rejects output that fails schema validation", async () => {
    const skill = buildBadOutputSkill();
    registerSkill(skill);

    await expect(invokeSkill(skill.name, {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, undefined)).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });

  // ── P1-A: retry contract ────────────────────────────────────────────────
  describe("retry policy (P1-A)", () => {
    function buildRetryingSkill(opts: {
      name: string;
      attemptsToSuccess: number;
      failWithCode?: "TIMEOUT" | "UPSTREAM_FAILURE" | "INPUT_INVALID" | "RATE_LIMITED";
      retryOn?: ("TIMEOUT" | "UPSTREAM_FAILURE" | "INPUT_INVALID" | "RATE_LIMITED")[];
      retryMaxAttempts?: number;
      backoffBaseMs?: number;
      rateLimitedDelayMs?: number;
    }): Skill<unknown, unknown> {
      let calls = 0;
      return {
        name: opts.name,
        agent: "personal",
        version: "1.0.0",
        allowedTools: ["profile:read"],
        timeoutMs: 1_000,
        needsConfirm: false,
        input: z.unknown(),
        output: z.unknown(),
        retry: opts.retryOn ? {
          maxAttempts: opts.retryMaxAttempts ?? 3,
          retryOn: opts.retryOn,
          backoffBaseMs: opts.backoffBaseMs ?? 1,
          rateLimitedDelayMs: opts.rateLimitedDelayMs ?? 1,
        } : undefined,
        async handler() {
          calls += 1;
          if (opts.failWithCode && calls < opts.attemptsToSuccess) {
            throw new SkillError(opts.failWithCode, `attempt ${calls} failed`);
          }
          return { ok: true, callCount: calls };
        },
      };
    }

    it("refuses to register a skill whose retry declaration pairs with a write scope", () => {
      const skill: Skill<unknown, unknown> = {
        name: "writes.skill",
        agent: "shared",
        version: "1.0.0",
        allowedTools: ["snapshot:read", "places:adopt"],
        timeoutMs: 1_000,
        needsConfirm: false,
        input: z.unknown(),
        output: z.unknown(),
        retry: {
          maxAttempts: 2,
          retryOn: ["TIMEOUT"],
          backoffBaseMs: 1,
          rateLimitedDelayMs: 1,
        },
        async handler() {
          return {};
        },
      };
      // Reset first to ensure no other test left it in.
      __resetRegistryForTests();
      expect(() => registerSkill(skill)).toThrowError(/retry but allowedTools contains write scope places:adopt/);
    });

    it("retries until success when the retryable error resolves", async () => {
      __resetRegistryForTests();
      const skill = buildRetryingSkill({
        name: "retry.until.success",
        attemptsToSuccess: 3,
        failWithCode: "TIMEOUT",
        retryOn: ["TIMEOUT"],
        retryMaxAttempts: 3,
        backoffBaseMs: 1,
      });
      registerSkill(skill);
      const result = await invokeSkill(skill.name, {
        ctx: createRequestContext(),
        policyGate: new DefaultPolicyGate("personal"),
      }, undefined);
      expect(result).toMatchObject({ ok: true, callCount: 3 });
    });

    it("does not retry when retryOn does not include the error code", async () => {
      __resetRegistryForTests();
      const skill = buildRetryingSkill({
        name: "no.retry.on.code",
        attemptsToSuccess: 99, // never succeeds
        failWithCode: "TIMEOUT",
        retryOn: ["UPSTREAM_FAILURE"], // does not include TIMEOUT
        retryMaxAttempts: 3,
      });
      registerSkill(skill);
      await expect(invokeSkill(skill.name, {
        ctx: createRequestContext(),
        policyGate: new DefaultPolicyGate("personal"),
      }, undefined)).rejects.toMatchObject({ code: "TIMEOUT" });
    });

    it("never retries INPUT_INVALID even if declared in retryOn", async () => {
      __resetRegistryForTests();
      const skill = buildRetryingSkill({
        name: "no.retry.on.input",
        attemptsToSuccess: 99,
        failWithCode: "INPUT_INVALID",
        retryOn: ["INPUT_INVALID"], // INPUT_INVALID is NEVER_RETRY regardless
        retryMaxAttempts: 3,
      });
      registerSkill(skill);
      await expect(invokeSkill(skill.name, {
        ctx: createRequestContext(),
        policyGate: new DefaultPolicyGate("personal"),
      }, undefined)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    });

    it("does not retry when caller signal aborts mid-attempt", async () => {
      __resetRegistryForTests();
      let calls = 0;
      const skill: Skill<unknown, unknown> = {
        name: "aborted.skill",
        agent: "personal",
        version: "1.0.0",
        allowedTools: ["profile:read"],
        timeoutMs: 100,
        needsConfirm: false,
        input: z.unknown(),
        output: z.unknown(),
        retry: {
          maxAttempts: 3,
          retryOn: ["TIMEOUT"],
          backoffBaseMs: 1,
          rateLimitedDelayMs: 1,
        },
        async handler() {
          calls += 1;
          throw new SkillError("TIMEOUT", "first attempt fails");
        },
      };
      registerSkill(skill);
      const controller = new AbortController();
      const promise = invokeSkill(skill.name, {
        ctx: createRequestContext(),
        policyGate: new DefaultPolicyGate("personal"),
      }, undefined, { signal: controller.signal });
      // Abort before any sleep completes; the registry should observe the
      // aborted signal at the top of the next iteration and stop.
      controller.abort(new Error("caller cancel"));
      await expect(promise).rejects.toBeDefined();
      expect(calls).toBe(1); // retry was not attempted
    });

    it("exhausts the retry budget and surfaces the original error", async () => {
      __resetRegistryForTests();
      const skill = buildRetryingSkill({
        name: "retry.exhausted",
        attemptsToSuccess: 99,
        failWithCode: "UPSTREAM_FAILURE",
        retryOn: ["UPSTREAM_FAILURE"],
        retryMaxAttempts: 3,
        backoffBaseMs: 1,
      });
      registerSkill(skill);
      await expect(invokeSkill(skill.name, {
        ctx: createRequestContext(),
        policyGate: new DefaultPolicyGate("personal"),
      }, undefined)).rejects.toMatchObject({ code: "UPSTREAM_FAILURE" });
    });
  });
});
