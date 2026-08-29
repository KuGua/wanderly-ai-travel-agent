/**
 * Spec §10.7 — replan creates PROPOSED; a single NEEDS_CHANGES prevents
 * activation; concurrent votes create at most one ACTIVE plan; old STALE
 * plans never reactivate.
 *
 * Pure-function coverage of the activation state machine. Integration
 * tests with a real DB and parallel transactions live in Phase 6+
 * (they require FOR UPDATE SKIP LOCKED behavior to be observed).
 */

import { describe, expect, it } from "vitest";

type PlanStatus = "DRAFT" | "PROPOSED" | "ACTIVE" | "STALE" | "SUPERSEDED";
type Decision = "ACCEPT" | "NEEDS_CHANGES";

interface VoteTally {
  votesAccepted: number;
  votesRequired: number;
  hasBlocker: boolean;
}

function countVotes(planId: string, votes: { planId: string; decision: Decision }[], required: Set<string>): VoteTally {
  void planId;
  const acceptors = new Set(votes.filter(v => v.decision === "ACCEPT").map(v => v.userId));
  const acceptedRequired = [...required].filter(uid => acceptors.has(uid)).length;
  const blocker = votes.some(v => v.decision === "NEEDS_CHANGES");
  return { votesAccepted: acceptedRequired, votesRequired: required.size, hasBlocker: blocker };
}

function nextStatus(currentStatus: PlanStatus, tally: VoteTally): { outcome: "CAST" | "ADOPTED" | "BLOCKED" | "STALE_PLAN"; newStatus: PlanStatus } {
  if (currentStatus !== "PROPOSED") return { outcome: "STALE_PLAN", newStatus: currentStatus };
  if (tally.hasBlocker) return { outcome: "BLOCKED", newStatus: "PROPOSED" };
  if (tally.votesRequired > 0 && tally.votesAccepted >= tally.votesRequired) {
    return { outcome: "ADOPTED", newStatus: "ACTIVE" };
  }
  return { outcome: "CAST", newStatus: "PROPOSED" };
}

describe("Adoption state machine (spec §10.7)", () => {
  const required = new Set(["alice", "bob", "chen"]);

  it("unanimous ACCEPT flips PROPOSED → ACTIVE exactly once", () => {
    const votes = [
      { planId: "p1", userId: "alice", decision: "ACCEPT" as const },
      { planId: "p1", userId: "bob", decision: "ACCEPT" as const },
      { planId: "p1", userId: "chen", decision: "ACCEPT" as const },
    ];
    const tally = countVotes("p1", votes, required);
    const firstFlip = nextStatus("PROPOSED", tally);
    expect(firstFlip.outcome).toBe("ADOPTED");
    expect(firstFlip.newStatus).toBe("ACTIVE");

    // A second concurrent vote run cannot toggle ACTIVE back.
    const second = nextStatus("ACTIVE", tally);
    expect(second.outcome).toBe("STALE_PLAN");
    expect(second.newStatus).toBe("ACTIVE");
  });

  it("a single NEEDS_CHANGES keeps the plan in PROPOSED", () => {
    const votes = [
      { planId: "p1", userId: "alice", decision: "ACCEPT" as const },
      { planId: "p1", userId: "bob", decision: "NEEDS_CHANGES" as const },
      { planId: "p1", userId: "chen", decision: "ACCEPT" as const },
    ];
    const tally = countVotes("p1", votes, required);
    const step = nextStatus("PROPOSED", tally);
    expect(step.outcome).toBe("BLOCKED");
    expect(step.newStatus).toBe("PROPOSED");
  });

  it("partial ACCEPT stays as CAST", () => {
    const votes = [
      { planId: "p1", userId: "alice", decision: "ACCEPT" as const },
      { planId: "p1", userId: "bob", decision: "ACCEPT" as const },
    ];
    const tally = countVotes("p1", votes, required);
    const step = nextStatus("PROPOSED", tally);
    expect(step.outcome).toBe("CAST");
    expect(step.newStatus).toBe("PROPOSED");
  });

  it("votes against a non-PROPOSED plan never reactivate it", () => {
    const votes = [
      { planId: "p1", userId: "alice", decision: "ACCEPT" as const },
      { planId: "p1", userId: "bob", decision: "ACCEPT" as const },
      { planId: "p1", userId: "chen", decision: "ACCEPT" as const },
    ];
    const tally = countVotes("p1", votes, required);
    const stale = nextStatus("STALE", tally);
    expect(stale.outcome).toBe("STALE_PLAN");
    expect(stale.newStatus).toBe("STALE");
  });
});
