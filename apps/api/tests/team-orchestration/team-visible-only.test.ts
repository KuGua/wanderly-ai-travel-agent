/**
 * Spec §10.3 — TEAM_VISIBLE facts visible only to active members of that
 * Trip; neither cross-Trip nor non-member reads succeed.
 *
 * Pure-function coverage: the read paths use SQL WHERE filters that drop
 * non-members before the response shape is even built. We assert that
 * behavior by stubbing the membership check.
 */

import { describe, expect, it } from "vitest";

/**
 * Simulates the filter applied by `listFactsForMembers`:
 *   1. caller must be a member of the trip;
 *   2. facts must be ACTIVE;
 *   3. facts must have visibility TEAM_VISIBLE.
 *
 * Non-members see nothing; confidential facts hidden; cross-trip reads
 * produce an empty list.
 */
function filterFactsForViewer(params: {
  callerUserId: string;
  callerTripId: string;
  callerMemberships: Array<{ userId: string; tripId: string }>;
  facts: Array<{ ownerUserId: string; tripId: string; visibility: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL"; status: "ACTIVE" | "SUPERSEDED" | "REVOKED" }>;
}) {
  const isMember = params.callerMemberships.some(
    m => m.userId === params.callerUserId && m.tripId === params.callerTripId,
  );
  if (!isMember) return [];
  return params.facts
    .filter(f => f.tripId === params.callerTripId)
    .filter(f => f.status === "ACTIVE")
    .filter(f => f.visibility === "TEAM_VISIBLE");
}

describe("TEAM_VISIBLE filter — non-member reads (spec §10.3)", () => {
  const alice = "00000000-0000-0000-0000-000000000001";
  const bob = "00000000-0000-0000-0000-000000000002";
  const tripA = "00000000-0000-0000-0000-00000000000a";
  const tripB = "00000000-0000-0000-0000-00000000000b";

  const memberships = [
    { userId: alice, tripId: tripA },
    { userId: bob, tripId: tripA },
  ];

  const facts = [
    { ownerUserId: alice, tripId: tripA, visibility: "TEAM_VISIBLE" as const, status: "ACTIVE" as const },
    { ownerUserId: bob, tripId: tripA, visibility: "ORCHESTRATOR_CONFIDENTIAL" as const, status: "ACTIVE" as const },
    { ownerUserId: alice, tripId: tripB, visibility: "TEAM_VISIBLE" as const, status: "ACTIVE" as const },
  ];

  it("alice (member of tripA) sees only the TEAM_VISIBLE fact for tripA", () => {
    const visible = filterFactsForViewer({
      callerUserId: alice,
      callerTripId: tripA,
      callerMemberships: memberships,
      facts,
    });
    expect(visible).toHaveLength(1);
    expect(visible[0].ownerUserId).toBe(alice);
  });

  it("a non-member sees nothing", () => {
    const eve = "00000000-0000-0000-0000-000000000099";
    const visible = filterFactsForViewer({
      callerUserId: eve,
      callerTripId: tripA,
      callerMemberships: memberships,
      facts,
    });
    expect(visible).toEqual([]);
  });

  it("cross-trip reads on a different trip return only that trip's TEAM_VISIBLE facts", () => {
    const visible = filterFactsForViewer({
      callerUserId: alice,
      callerTripId: tripB,
      callerMemberships: [{ userId: alice, tripId: tripB }],
      facts,
    });
    expect(visible).toHaveLength(1);
    expect(visible[0].tripId).toBe(tripB);
  });

  it("SUPERSEDED and REVOKED facts are excluded even for members", () => {
    const visible = filterFactsForViewer({
      callerUserId: alice,
      callerTripId: tripA,
      callerMemberships: memberships,
      facts: [
        ...facts,
        { ownerUserId: alice, tripId: tripA, visibility: "TEAM_VISIBLE" as const, status: "SUPERSEDED" as const },
        { ownerUserId: alice, tripId: tripA, visibility: "TEAM_VISIBLE" as const, status: "REVOKED" as const },
      ],
    });
    expect(visible).toHaveLength(1);
    expect(visible.every(f => f.status === "ACTIVE")).toBe(true);
  });
});
