import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  auditEvents,
  idempotencyRecords,
  memoryProposals,
  preferenceFacts,
  userProfiles,
  users,
} from "../src/db/schema.js";
import { listActiveFacts, replaceFact } from "../src/services/preference-fact-service.js";
import {
  clearPendingProposalsForField,
  confirmProposal,
  deleteProposalsForField,
  dismissProposal,
  expireStaleProposals,
  listPendingProposals,
  listSurfaceableProposals,
  observeBehavior,
} from "../src/services/memory-proposal-service.js";
import { MEMORY_ACTIVATION_POLICY_V1 } from "../src/memory/memory-activation-policy.js";

const ctx = { correlationId: "00000000-0000-4000-8000-0000000000bb", actorUserId: undefined } as never;

const DAY = 86_400_000;
const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

const TRIP_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TRIP_B = "bbbbbbbb-0000-4000-8000-000000000002";
const TRIP_C = "cccccccc-0000-4000-8000-000000000003";

let ownerId: string;
let otherId: string;
let profileId: string;

async function ensureUser(externalId: string): Promise<string> {
  const [created] = await db.insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  if (created) return created.id;
  const [existing] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
  return existing!.id;
}

async function cleanup() {
  const ids = [ownerId, otherId].filter(Boolean);
  if (ids.length === 0) return;
  await db.delete(memoryProposals).where(inArray(memoryProposals.userId, ids));
  await db.delete(preferenceFacts).where(inArray(preferenceFacts.userId, ids));
  await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, ids));
  await db.delete(idempotencyRecords).where(eq(idempotencyRecords.entityType, "memory_observation"));
}

/** One server-confirmed observation. Each call is a distinct episode. */
let episodeSeq = 0;
function observe(overrides: {
  value?: unknown;
  tripId?: string;
  dayOffset?: number;
  episodeId?: string;
  fieldKey?: string;
  userId?: string;
} = {}) {
  episodeSeq += 1;
  return observeBehavior({
    ctx,
    userId: overrides.userId ?? ownerId,
    profileId,
    fieldKey: overrides.fieldKey ?? "trip_pace",
    value: overrides.value ?? "packed",
    episodeId: overrides.episodeId ?? `episode-${episodeSeq}`,
    tripId: overrides.tripId ?? TRIP_A,
    observedAt: at(overrides.dayOffset ?? 0),
  });
}

/**
 * Evidence that clears every gate: 4 episodes, 2 trips, a 40-day span, and
 * enough recency to pass the activation threshold (B ≈ 0.88 against τ = 0.50).
 *
 * Deliberately not the bare minimum — see the boundary test below, which shows
 * that the minimum count/span gates alone do not guarantee activation passes.
 */
async function buildQualifyingEvidence(value = "packed") {
  await observe({ value, tripId: TRIP_A, dayOffset: 0 });
  await observe({ value, tripId: TRIP_B, dayOffset: 20 });
  await observe({ value, tripId: TRIP_B, dayOffset: 38 });
  return observe({ value, tripId: TRIP_B, dayOffset: 40 });
}

beforeAll(async () => {
  ownerId = await ensureUser("proposal-owner");
  otherId = await ensureUser("proposal-other");
  const [profile] = await db.insert(userProfiles)
    .values({ userId: ownerId, displayName: "Owner" })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  profileId = profile
    ? profile.id
    : (await db.select().from(userProfiles).where(eq(userProfiles.userId, ownerId)).limit(1))[0]!.id;
});

afterAll(cleanup);
beforeEach(cleanup);

describe("evidence aggregation", () => {
  it("rejects sensitive fields at the behaviour entry point", async () => {
    const result = await observe({ fieldKey: "nationality", value: "Singapore" });
    expect(result).toEqual({ outcome: "REJECTED", reason: "SENSITIVE_FIELD" });
    expect(await listPendingProposals(ownerId)).toHaveLength(0);
  });

  it("rejects fields that are decisions rather than habits", async () => {
    const result = await observe({ fieldKey: "budget_max_usd", value: 3000 });
    expect(result).toEqual({ outcome: "REJECTED", reason: "SENSITIVE_FIELD" });
  });

  it("merges repeat observations into one aggregate row", async () => {
    await buildQualifyingEvidence();
    const pending = await listPendingProposals(ownerId);
    expect(pending).toHaveLength(1);
    expect(pending[0].observationCount).toBe(4);
    expect(pending[0].distinctEpisodeCount).toBe(4);
    expect(pending[0].distinctTripCount).toBe(2);
  });

  it("does not count a replayed action/event id", async () => {
    await observe({ episodeId: "shared-episode", dayOffset: 0 });
    const replay = await observe({ episodeId: "shared-episode", dayOffset: 1 });

    expect(replay).toEqual({ outcome: "DUPLICATE_EPISODE" });
    expect((await listPendingProposals(ownerId))[0].observationCount).toBe(1);
  });

  it("counts two distinct episodes that land on the same UTC day", async () => {
    // Independence comes from the episode id, never from elapsed time.
    await observe({ episodeId: "morning", dayOffset: 0 });
    await observe({ episodeId: "evening", dayOffset: 0 });

    const [pending] = await listPendingProposals(ownerId);
    expect(pending.observationCount).toBe(2);
    expect(pending.distinctEpisodeCount).toBe(2);
  });

  it("counts one trip once, however many episodes it contributes", async () => {
    await observe({ tripId: TRIP_A, dayOffset: 0 });
    await observe({ tripId: TRIP_A, dayOffset: 10 });
    await observe({ tripId: TRIP_A, dayOffset: 20 });

    expect((await listPendingProposals(ownerId))[0].distinctTripCount).toBe(1);
  });

  it("caps the observation window at the policy depth", async () => {
    for (let day = 0; day < MEMORY_ACTIVATION_POLICY_V1.recentDepth + 5; day += 1) {
      await observe({ dayOffset: day });
    }
    const [row] = await db.select().from(memoryProposals).where(eq(memoryProposals.userId, ownerId));
    expect(row.recentObservedOn.length).toBe(MEMORY_ACTIVATION_POLICY_V1.recentDepth);
    expect(row.observationCount).toBe(MEMORY_ACTIVATION_POLICY_V1.recentDepth + 5);
  });

  it("stamps the scoring version that was in force", async () => {
    await observe();
    expect((await listPendingProposals(ownerId))[0].scoringVersion).toBe("petrov-hybrid-v1");
  });
});

describe("expiry is enforced at every decision point", () => {
  /** Ages a proposal past its life without running the sweep. */
  async function lapse() {
    await db.update(memoryProposals)
      .set({ expiresAt: at(39) })
      .where(eq(memoryProposals.userId, ownerId));
  }

  it("does not surface a lapsed proposal even before the sweep runs", async () => {
    await buildQualifyingEvidence();
    expect(await listSurfaceableProposals(ownerId, { now: at(40) })).toHaveLength(1);

    // The sweep is periodic and the Worker may be stopped, so PENDING on its
    // own does not mean the suggestion is still offered.
    await lapse();
    expect(await listSurfaceableProposals(ownerId, { now: at(40) })).toHaveLength(0);
  });

  it("refuses to confirm a lapsed proposal", async () => {
    await buildQualifyingEvidence();
    const [proposal] = await listPendingProposals(ownerId);
    await lapse();

    const result = await confirmProposal({ ctx, userId: ownerId, proposalId: proposal.id, now: at(40) });
    expect(result.outcome).toBe("EXPIRED");
    // No fact: confirming here would resurrect a suggestion policy retired.
    expect(await listActiveFacts(ownerId)).toHaveLength(0);
  });

  it("retires the row rather than leaving it to be offered again", async () => {
    await buildQualifyingEvidence();
    const [proposal] = await listPendingProposals(ownerId);
    await lapse();
    await confirmProposal({ ctx, userId: ownerId, proposalId: proposal.id, now: at(40) });

    const [row] = await db.select().from(memoryProposals)
      .where(eq(memoryProposals.id, proposal.id));
    expect(row.status).toBe("EXPIRED");
    expect(row.recentObservedOn).toEqual([]);
    expect(row.cooldownUntil).not.toBeNull();
  });
});

describe("trigger rule", () => {
  it("surfaces a candidate once every gate is satisfied", async () => {
    const result = await buildQualifyingEvidence();
    expect(result).toMatchObject({ outcome: "AGGREGATED", surfaceable: true, blockedBy: null });

    const surfaced = await listSurfaceableProposals(ownerId, { now: at(40) });
    expect(surfaced).toHaveLength(1);
  });

  it("does not surface evidence confined to one trip", async () => {
    for (const dayOffset of [0, 20, 38, 40]) {
      await observe({ tripId: TRIP_A, dayOffset });
    }
    const evaluation = await observe({ tripId: TRIP_A, dayOffset: 41 });

    expect(evaluation).toMatchObject({ surfaceable: false, blockedBy: "TRIPS" });
    expect(await listSurfaceableProposals(ownerId, { now: at(41) })).toHaveLength(0);
  });

  it("does not surface evidence spanning under 30 days", async () => {
    await observe({ tripId: TRIP_A, dayOffset: 0 });
    await observe({ tripId: TRIP_B, dayOffset: 2 });
    await observe({ tripId: TRIP_B, dayOffset: 4 });
    const fourth = await observe({ tripId: TRIP_B, dayOffset: 6 });

    expect(fourth).toMatchObject({ surfaceable: false, blockedBy: "SPAN" });
  });

  it("does not surface fewer than the minimum independent observations", async () => {
    await observe({ tripId: TRIP_A, dayOffset: 0 });
    const second = await observe({ tripId: TRIP_B, dayOffset: 20 });

    // Two is one short of the minimum, which is 3 — see the policy comment.
    // The distinct-trip gate is already satisfied here, so the count gate is
    // the only thing holding it back.
    expect(second).toMatchObject({ surfaceable: false, blockedBy: "OBSERVATIONS" });
  });

  it("surfaces the minimum evidence spread across the window", async () => {
    // Three confirmations in three trips over exactly the 30-day span gate.
    // This is the cheapest evidence that may surface at all, so if the policy
    // constants ever drift out of agreement it fails here first.
    await observe({ tripId: TRIP_A, dayOffset: 0 });
    await observe({ tripId: TRIP_B, dayOffset: 15 });
    const third = await observe({ tripId: TRIP_C, dayOffset: 30 });

    expect(third).toMatchObject({ surfaceable: true });
    if (third.outcome !== "AGGREGATED") throw new Error("expected aggregation");
    expect(third.activation).toBeGreaterThan(MEMORY_ACTIVATION_POLICY_V1.activationThreshold);
  });

  it("does not surface the same evidence bunched at the old end of the window", async () => {
    // Same three observations and the same 30-day span, but two of them sit at
    // the far edge: B = 0.475 against tau = 0.50. Three is deliberately set
    // where spread-out evidence passes and bunched evidence does not.
    await observe({ tripId: TRIP_A, dayOffset: 0 });
    await observe({ tripId: TRIP_B, dayOffset: 0 });
    const third = await observe({ tripId: TRIP_C, dayOffset: 30 });

    expect(third).toMatchObject({ surfaceable: false, blockedBy: "ACTIVATION" });
  });

  it("can still block on activation after every count and span gate passes", async () => {
    // Four episodes across two trips spanning 180 days satisfies every
    // count-based gate, yet B = 0.46 falls under tau = 0.50. Evidence smeared
    // across six months is not a habit, and decay is what says so — the
    // count gates alone cannot express that.
    await observe({ tripId: TRIP_A, dayOffset: 0 });
    await observe({ tripId: TRIP_B, dayOffset: 60 });
    await observe({ tripId: TRIP_B, dayOffset: 120 });
    const fourth = await observe({ tripId: TRIP_B, dayOffset: 180 });

    expect(fourth).toMatchObject({ surfaceable: false, blockedBy: "ACTIVATION" });
    if (fourth.outcome !== "AGGREGATED") throw new Error("expected aggregation");
    expect(fourth.activation).toBeLessThan(0.50);
  });

  it("surfaces the same four episodes once they are spread only 30 days", async () => {
    // The counterpart to the case above: the minimum span, comfortably clear
    // of the threshold. This is the pairing the policy comment describes.
    await observe({ tripId: TRIP_A, dayOffset: 0 });
    await observe({ tripId: TRIP_B, dayOffset: 10 });
    await observe({ tripId: TRIP_B, dayOffset: 20 });
    const fourth = await observe({ tripId: TRIP_B, dayOffset: 30 });

    expect(fourth).toMatchObject({ surfaceable: true, blockedBy: null });
  });

  it("does not surface a candidate whose activation is below the threshold", async () => {
    await buildQualifyingEvidence();
    // Raising the bar out of reach must suppress it without touching evidence.
    const strict = { ...MEMORY_ACTIVATION_POLICY_V1, activationThreshold: 99 };
    expect(await listSurfaceableProposals(ownerId, { now: at(40), policy: strict })).toHaveLength(0);
  });

  it("stays silent when two candidates for one field are within ln(2)", async () => {
    // Identical evidence for two values: neither can lead by the margin.
    await observe({ value: "packed", tripId: TRIP_A, dayOffset: 0 });
    await observe({ value: "packed", tripId: TRIP_B, dayOffset: 20 });
    await observe({ value: "packed", tripId: TRIP_B, dayOffset: 40 });
    await observe({ value: "relaxed", tripId: TRIP_A, dayOffset: 0 });
    await observe({ value: "relaxed", tripId: TRIP_B, dayOffset: 20 });
    await observe({ value: "relaxed", tripId: TRIP_B, dayOffset: 40 });

    expect(await listPendingProposals(ownerId)).toHaveLength(2);
    expect(await listSurfaceableProposals(ownerId, { now: at(40) })).toHaveLength(0);
  });

  it("surfaces the leader once it clears the runner-up by the margin", async () => {
    await observe({ value: "relaxed", tripId: TRIP_A, dayOffset: 0 });
    await observe({ value: "relaxed", tripId: TRIP_B, dayOffset: 20 });
    await observe({ value: "relaxed", tripId: TRIP_B, dayOffset: 40 });

    // The challenger accumulates far more recent evidence.
    for (let day = 0; day <= 40; day += 4) {
      await observe({ value: "packed", tripId: day % 8 === 0 ? TRIP_A : TRIP_B, dayOffset: day });
    }

    const surfaced = await listSurfaceableProposals(ownerId, { now: at(40) });
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0].proposedValue).toBe("packed");
  });
});

describe("facts never decay and are never rewritten by behaviour", () => {
  it("leaves a stated fact untouched no matter how much evidence accrues", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });

    await buildQualifyingEvidence("packed");

    const active = await listActiveFacts(ownerId);
    expect(active.find((fact) => fact.fieldKey === "trip_pace")?.value).toBe("relaxed");
  });

  it("only creates a fact when the owner confirms", async () => {
    await buildQualifyingEvidence();
    const [pending] = await listPendingProposals(ownerId);

    expect(await listActiveFacts(ownerId)).toHaveLength(0);
    const confirmed = await confirmProposal({ ctx, userId: ownerId, proposalId: pending.id, now: at(40) });

    expect(confirmed.outcome).toBe("CONFIRMED");
    expect((await listActiveFacts(ownerId))[0]).toMatchObject({
      value: "packed",
      source: "PROPOSAL_CONFIRMATION",
    });
  });
});

describe("terminal states", () => {
  it("confirming twice yields one fact and one terminal state", async () => {
    await buildQualifyingEvidence();
    const [pending] = await listPendingProposals(ownerId);

    const first = await confirmProposal({ ctx, userId: ownerId, proposalId: pending.id, now: at(40) });
    const second = await confirmProposal({ ctx, userId: ownerId, proposalId: pending.id, now: at(40) });

    expect(first.outcome).toBe("CONFIRMED");
    expect(second.outcome).toBe("ALREADY_RESOLVED");
    expect(await listActiveFacts(ownerId)).toHaveLength(1);
  });

  it("resolves a confirm/dismiss race to a single terminal state", async () => {
    await buildQualifyingEvidence();
    const [pending] = await listPendingProposals(ownerId);

    const [a, b] = await Promise.all([
      confirmProposal({ ctx, userId: ownerId, proposalId: pending.id, now: at(40) }),
      dismissProposal({ ctx, userId: ownerId, proposalId: pending.id }),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toContain("ALREADY_RESOLVED");
    expect(outcomes.filter((o) => o === "CONFIRMED" || o === "DISMISSED")).toHaveLength(1);
    // A racing confirm must never produce two facts.
    expect((await listActiveFacts(ownerId)).length).toBeLessThanOrEqual(1);
  });

  it("clears the observation window when a proposal is confirmed", async () => {
    await buildQualifyingEvidence();
    const [pending] = await listPendingProposals(ownerId);
    await confirmProposal({ ctx, userId: ownerId, proposalId: pending.id, now: at(40) });

    const [row] = await db.select().from(memoryProposals).where(eq(memoryProposals.id, pending.id));
    expect(row.recentObservedOn).toEqual([]);
    expect(row.contributingTripIds).toEqual([]);
  });

  it("clears the observation window when a proposal is dismissed", async () => {
    await buildQualifyingEvidence();
    const [pending] = await listPendingProposals(ownerId);
    await dismissProposal({ ctx, userId: ownerId, proposalId: pending.id });

    const [row] = await db.select().from(memoryProposals).where(eq(memoryProposals.id, pending.id));
    expect(row.recentObservedOn).toEqual([]);
    expect(row.cooldownUntil).not.toBeNull();
  });

  it("suppresses the same field/value for the dismissal cooldown", async () => {
    await buildQualifyingEvidence();
    const [pending] = await listPendingProposals(ownerId);
    await dismissProposal({ ctx, userId: ownerId, proposalId: pending.id });

    const blocked = await observe({ dayOffset: 60 });
    expect(blocked).toEqual({ outcome: "IN_COOLDOWN" });
    expect(await listPendingProposals(ownerId)).toHaveLength(0);
  });

  it("expires an unanswered proposal and clears its evidence", async () => {
    await buildQualifyingEvidence();
    await db.update(memoryProposals)
      .set({ expiresAt: at(-1) })
      .where(eq(memoryProposals.userId, ownerId));

    expect(await expireStaleProposals(T0)).toBe(1);
    const [row] = await db.select().from(memoryProposals).where(eq(memoryProposals.userId, ownerId));
    expect(row.status).toBe("EXPIRED");
    expect(row.recentObservedOn).toEqual([]);
    expect(row.cooldownUntil).not.toBeNull();
  });
});

describe("owner isolation and deletion", () => {
  it("will not let another user resolve someone's proposal", async () => {
    await buildQualifyingEvidence();
    const [pending] = await listPendingProposals(ownerId);

    expect(await confirmProposal({ ctx, userId: otherId, proposalId: pending.id, now: at(40) }))
      .toEqual({ outcome: "NOT_FOUND" });
    expect(await dismissProposal({ ctx, userId: otherId, proposalId: pending.id }))
      .toEqual({ outcome: "NOT_FOUND" });
  });

  it("keeps another owner's proposals out of the listing", async () => {
    await buildQualifyingEvidence();
    expect(await listPendingProposals(otherId)).toHaveLength(0);
  });

  it("drops conflicting pending candidates when the owner states the value directly", async () => {
    await buildQualifyingEvidence();
    expect(await clearPendingProposalsForField({ userId: ownerId, fieldKey: "trip_pace" })).toBe(1);
    expect(await listPendingProposals(ownerId)).toHaveLength(0);
  });

  it("removes every proposal for a field when its memory is deleted", async () => {
    await buildQualifyingEvidence();
    const [pending] = await listPendingProposals(ownerId);
    await dismissProposal({ ctx, userId: ownerId, proposalId: pending.id });

    await deleteProposalsForField({ userId: ownerId, fieldKey: "trip_pace" });
    const rows = await db.select().from(memoryProposals)
      .where(and(eq(memoryProposals.userId, ownerId), eq(memoryProposals.fieldKey, "trip_pace")));
    expect(rows).toHaveLength(0);
  });
});

describe("telemetry redaction", () => {
  it("keeps values, dates and trip references out of the audit trail", async () => {
    await buildQualifyingEvidence("packed");
    const [pending] = await listPendingProposals(ownerId);
    await confirmProposal({ ctx, userId: ownerId, proposalId: pending.id, now: at(40) });

    const events = await db.select().from(auditEvents).where(eq(auditEvents.actorUserId, ownerId));
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain("packed");
    expect(serialized).not.toContain(TRIP_A);
    expect(serialized).not.toContain(TRIP_B);
    expect(serialized).not.toContain("2026-01-01");
    expect(serialized).toContain("MEMORY_PROPOSAL_CONFIRM");
  });

  it("never exposes the observation window or trip ids through the read API", async () => {
    await buildQualifyingEvidence();
    const serialized = JSON.stringify(await listSurfaceableProposals(ownerId, { now: at(40) }));

    expect(serialized).not.toContain("recentObservedOn");
    expect(serialized).not.toContain("contributingTripIds");
    expect(serialized).not.toContain(TRIP_A);
    expect(serialized).not.toContain("activation");
  });
});
