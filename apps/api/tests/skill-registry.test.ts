import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import { __resetRegistryForTests, registerSkill, invokeSkill } from "../src/agents/skill-registry.js";
import { SkillError } from "../src/agents/errors.js";
import type { Skill } from "../src/agents/contracts.js";
import { createRequestContext } from "../src/utils/context.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";

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
  });

  it("invokes a skill and records success", async () => {
    const skill = buildEchoSkill("1.0.0");
    registerSkill(skill);

    const result = await invokeSkill(skill.name, {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, { v: 2 });

    expect(result).toEqual({ doubled: 4 });
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
  });

  it("rejects output that fails schema validation", async () => {
    const skill = buildBadOutputSkill();
    registerSkill(skill);

    await expect(invokeSkill(skill.name, {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, undefined)).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
  });
});
