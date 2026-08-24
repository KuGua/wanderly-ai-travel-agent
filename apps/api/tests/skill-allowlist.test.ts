import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import {
  __resetRegistryForTests,
  registerSkill,
  invokeSkill,
} from "../src/agents/skill-registry.js";
import { SkillError } from "../src/agents/errors.js";
import { DefaultPolicyGate } from "../src/agents/policy-gate.js";
import { createRequestContext } from "../src/utils/context.js";
import type { Skill } from "../src/agents/contracts.js";

const sharedInput = z.object({ id: z.string() });
const sharedOutput = z.object({ ok: z.literal(true) });

describe("skill allow-list enforcement", () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it("rejects personal skills declaring bookings at registration time", () => {
    const personal: Skill<{ id: string }, { ok: true }> = {
      name: "bad.personal",
      agent: "personal",
      version: "1.0.0",
      allowedTools: ["bookings"],
      timeoutMs: 1000,
      needsConfirm: false,
      input: sharedInput,
      output: sharedOutput,
      async handler() { return { ok: true as const }; },
    };

    expect(() => registerSkill(personal)).toThrowError(SkillError);
  });

  it("rejects personal context invoking a shared skill", async () => {
    const shared: Skill<{ id: string }, { ok: true }> = {
      name: "shared.skill",
      agent: "shared",
      version: "1.0.0",
      allowedTools: ["plan:write:propose"],
      timeoutMs: 1000,
      needsConfirm: false,
      input: sharedInput,
      output: sharedOutput,
      async handler() { return { ok: true as const }; },
    };
    registerSkill(shared);

    await expect(invokeSkill(shared.name, {
      ctx: createRequestContext(),
      policyGate: new DefaultPolicyGate("personal"),
    }, { id: "x" })).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
  });

  it("allows shared context invoking a shared skill with allowed scope", async () => {
    const shared: Skill<{ id: string }, { ok: true }> = {
      name: "shared.allowed",
      agent: "shared",
      version: "1.0.0",
      allowedTools: ["plan:write:propose"],
      timeoutMs: 1000,
      needsConfirm: false,
      input: sharedInput,
      output: sharedOutput,
      async handler() { return { ok: true as const }; },
    };
    registerSkill(shared);

    const result = await invokeSkill(shared.name, {
      ctx: createRequestContext(),
      snapshot: {
        authorizedData: {},
        departureCities: [],
        destinationCandidates: [],
      },
      policyGate: new DefaultPolicyGate("shared"),
    }, { id: "x" });

    expect(result).toEqual({ ok: true });
  });
});