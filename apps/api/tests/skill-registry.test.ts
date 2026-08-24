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

  it("rejects stale-version reuse", async () => {
    const skill = buildEchoSkill("1.0.0");
    registerSkill(skill);

    const ctx = { ctx: createRequestContext(), policyGate: new DefaultPolicyGate("personal") };

    await invokeSkill(skill.name, ctx, { v: 1 });
    await expect(invokeSkill(skill.name, ctx, { v: 2 })).rejects.toMatchObject({
      code: "OUTPUT_INVALID",
    });

    const bumped = buildEchoSkill("1.0.1");
    registerSkill(bumped);
    await expect(invokeSkill(bumped.name, ctx, { v: 3 })).resolves.toEqual({ doubled: 6 });
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