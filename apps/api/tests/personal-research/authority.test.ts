import { describe, expect, it } from "vitest";

import { DefaultPolicyGate } from "../../src/agents/policy-gate.js";
import { SkillError } from "../../src/agents/errors.js";
import type { ResearchAuthority } from "../../src/agents/contracts.js";

/**
 * Unit tests for `DefaultPolicyGate.requirePersonalResearchAuthority`. The
 * gate is the single owner-only authorization boundary for the new
 * `PERSONAL_RESEARCH` operation; these tests cover every spec §3.1 invariant
 * without a DB or HTTP. Source: docs/draft-personal-research-implementation.md
 * §3.1.
 */

const baseRun = {
  id: "run-1",
  createdByUserId: "owner-1",
  tripId: "trip-1",
  threadId: "thread-1",
  snapshotId: null,
  operation: "PERSONAL_RESEARCH",
} as unknown as Parameters<DefaultPolicyGate["requirePersonalResearchAuthority"]>[1];

const baseAuthority: ResearchAuthority = {
  kind: "PERSONAL",
  tripId: "trip-1",
  threadId: "thread-1",
  ownerUserId: "owner-1",
  runId: "run-1",
  capability: "flight.search",
};

describe("DefaultPolicyGate.requirePersonalResearchAuthority", () => {
  it("accepts a structurally valid PERSONAL authority", () => {
    const gate = new DefaultPolicyGate("personal");
    expect(() => gate.requirePersonalResearchAuthority(baseAuthority, baseRun)).not.toThrow();
  });

  it("rejects a SHARED authority", () => {
    const gate = new DefaultPolicyGate("personal");
    const shared: ResearchAuthority = {
      kind: "SHARED",
      tripId: "trip-1",
      snapshotId: "snap-1",
      runId: "run-1",
    };
    expect(() => gate.requirePersonalResearchAuthority(shared, baseRun)).toThrow(SkillError);
  });

  it("rejects when the run's ownerUserId does not match the authority", () => {
    const gate = new DefaultPolicyGate("personal");
    const wrongOwner: ResearchAuthority = { ...baseAuthority, ownerUserId: "attacker" };
    expect(() => gate.requirePersonalResearchAuthority(wrongOwner, baseRun)).toThrow(SkillError);
  });

  it("rejects when the run's tripId does not match the authority", () => {
    const gate = new DefaultPolicyGate("personal");
    const wrongTrip: ResearchAuthority = { ...baseAuthority, tripId: "trip-2" };
    expect(() => gate.requirePersonalResearchAuthority(wrongTrip, baseRun)).toThrow(SkillError);
  });

  it("rejects when the run's threadId does not match the authority", () => {
    const gate = new DefaultPolicyGate("personal");
    const wrongThread: ResearchAuthority = { ...baseAuthority, threadId: "thread-2" };
    expect(() => gate.requirePersonalResearchAuthority(wrongThread, baseRun)).toThrow(SkillError);
  });

  it("rejects when the run has a snapshotId (must be null for PERSONAL_RESEARCH)", () => {
    const gate = new DefaultPolicyGate("personal");
    const runWithSnapshot = { ...baseRun, snapshotId: "snap-1" };
    expect(() => gate.requirePersonalResearchAuthority(baseAuthority, runWithSnapshot)).toThrow(SkillError);
  });

  it("rejects a capability that is not in the runtime allow-list", () => {
    const gate = new DefaultPolicyGate("personal");
    const visaAuthority: ResearchAuthority = { ...baseAuthority, capability: "visa.readiness" as never };
    expect(() => gate.requirePersonalResearchAuthority(visaAuthority, baseRun)).toThrow(SkillError);
  });
});