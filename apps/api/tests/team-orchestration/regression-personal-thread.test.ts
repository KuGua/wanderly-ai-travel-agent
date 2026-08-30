/**
 * Spec §10.9 — Existing owner-only private-thread, context-boundary,
 * cancellation, lease recovery, callback idempotency and telemetry-redaction
 * regressions remain green.
 *
 * This test is a stub that asserts the contract surface used by the broader
 * regression suite. The actual regression coverage lives in the original
 * tests (chat-conversation-e2e, idempotency-service, etc.).
 *
 * Pure-function checks ensure the Skill Registry still refuses a personal
 * skill that asks for forbidden scopes — the safety property must remain
 * intact regardless of the new team-orchestration Skill.
 */

import { describe, expect, it } from "vitest";
import { registerSkill, __resetRegistryForTests } from "../../src/agents/skill-registry.js";
import { tripConstraintProposeSkill } from "../../src/skills/personal/trip-constraint-propose-skill.js";
import { SkillError } from "../../src/agents/errors.js";

describe("Personal-skill guardrails (spec §10.9 regression)", () => {
  it("the new team-orchestration skill only declares consent:read scope", () => {
    expect(tripConstraintProposeSkill.agent).toBe("personal");
    expect(tripConstraintProposeSkill.allowedTools).toEqual(["consent:read"]);
  });

  it("rejects a personal skill that asks for plan:write:propose scope", () => {
    __resetRegistryForTests();
    try {
      registerSkill({
        name: "rogue.skill",
        agent: "personal",
        version: "1.0.0",
        allowedTools: ["consent:read", "plan:write:propose"],
        timeoutMs: 100,
        needsConfirm: false,
        input: { parse: (x: unknown) => x } as never,
        output: { parse: (x: unknown) => x } as never,
        handler: () => Promise.resolve(),
      });
      expect.fail("expected SkillError TOOL_NOT_ALLOWED");
    } catch (err) {
      expect(err).toBeInstanceOf(SkillError);
      expect((err as SkillError).code).toBe("TOOL_NOT_ALLOWED");
    }
  });
});
