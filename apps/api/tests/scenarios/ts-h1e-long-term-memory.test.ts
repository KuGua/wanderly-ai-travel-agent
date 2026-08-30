/**
 * TS-H1e — Maintain structured long-term and current-Trip memory without
 * widening consent (docs/test-scenarios.md).
 *
 * The unit suites each prove one rule. This walks the whole path with the real
 * services, because the guarantees this feature makes are about how those rules
 * compose: evidence must not become a fact, a fact must not reach a trip that
 * did not consent, and a member must not see another member's memory.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../../src/db/database.js";
import {
  auditEvents,
  consentGrants,
  idempotencyRecords,
  itineraryPlans,
  memoryProposals,
  preferenceFacts,
  sharedTrips,
  tripConstraintFacts,
  tripMembers,
  userProfiles,
  users,
} from "../../src/db/schema.js";
import {
  clearPendingProposalsForField,
  confirmProposal,
  dismissProposal,
  listPendingProposals,
  listSurfaceableProposals,
  observeBehavior,
} from "../../src/services/memory-proposal-service.js";
import {
  deleteFact,
  listActiveFacts,
  replaceFact,
} from "../../src/services/preference-fact-service.js";
import {
  deleteTripMemory,
  listGroupDecisions,
  listOverridesForOwner,
  saveGroupDecision,
  saveOverride,
} from "../../src/services/trip-memory-service.js";
import { buildMemoryNamespace } from "../../src/services/memory-projection-builder.js";
import { readMemoryProjection } from "../../src/skills/shared/memory-projection-input.js";
import { MEMORY_ACTIVATION_POLICY_V1 } from "../../src/memory/memory-activation-policy.js";
import { provisionTripAndMember } from "../helpers/trip.js";

const ctx = { correlationId: "00000000-0000-4000-8000-00000000e1e5", actorUserId: undefined } as never;

const DAY = 86_400_000;
const T0 = new Date("2026-03-01T00:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

let aliceId: string;
let bobId: string;
let aliceProfileId: string;
/** Trip 1 consents to accommodation style; Trip 2 deliberately does not. */
let consentedTripId: string;
let unconsentedTripId: string;

async function ensureUser(externalId: string): Promise<string> {
  const [created] = await db.insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  if (created) return created.id;
  const [row] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
  return row!.id;
}

async function cleanup() {
  const userIds = [aliceId, bobId].filter(Boolean);
  const tripIds = [consentedTripId, unconsentedTripId].filter(Boolean);
  if (userIds.length > 0) {
    await db.delete(memoryProposals).where(inArray(memoryProposals.userId, userIds));
    await db.delete(preferenceFacts).where(inArray(preferenceFacts.userId, userIds));
    await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, userIds));
  }
  await db.delete(idempotencyRecords)
    .where(eq(idempotencyRecords.entityType, "memory_observation"));
  if (tripIds.length > 0) {
    await db.delete(itineraryPlans).where(inArray(itineraryPlans.tripId, tripIds));
    await db.delete(tripConstraintFacts).where(inArray(tripConstraintFacts.tripId, tripIds));
    await db.delete(consentGrants).where(inArray(consentGrants.tripId, tripIds));
    await db.delete(tripMembers).where(inArray(tripMembers.tripId, tripIds));
    await db.delete(sharedTrips).where(inArray(sharedTrips.id, tripIds));
  }
}

/** One server-confirmed episode, the only thing that produces evidence. */
let episodeSeq = 0;
function observe(overrides: {
  value?: unknown;
  fieldKey?: string;
  tripId?: string;
  dayOffset?: number;
  episodeId?: string;
} = {}) {
  episodeSeq += 1;
  return observeBehavior({
    ctx,
    userId: aliceId,
    profileId: aliceProfileId,
    fieldKey: overrides.fieldKey ?? "accommodation_style",
    value: overrides.value ?? "budget",
    episodeId: overrides.episodeId ?? `ts-h1e-episode-${episodeSeq}`,
    tripId: overrides.tripId ?? consentedTripId,
    observedAt: at(overrides.dayOffset ?? 0),
  });
}

/** Step 1's evidence: three trips, 30 days, spread across the window. */
async function recordQualifyingEvidence(value = "budget") {
  await observe({ value, tripId: consentedTripId, dayOffset: 0 });
  await observe({ value, tripId: unconsentedTripId, dayOffset: 15 });
  return observe({ value, tripId: thirdTripId, dayOffset: 30 });
}

let thirdTripId: string;

beforeAll(async () => {
  aliceId = await ensureUser("ts-h1e-alice");
  bobId = await ensureUser("ts-h1e-bob");
  const [profile] = await db.insert(userProfiles)
    .values({ userId: aliceId, displayName: "Alice" })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  aliceProfileId = profile
    ? profile.id
    : (await db.select().from(userProfiles).where(eq(userProfiles.userId, aliceId)).limit(1))[0]!.id;
});

afterAll(cleanup);

beforeEach(async () => {
  await cleanup();
  ({ tripId: consentedTripId } = await provisionTripAndMember({ ownerUserId: aliceId }));
  ({ tripId: unconsentedTripId } = await provisionTripAndMember({ ownerUserId: aliceId }));
  ({ tripId: thirdTripId } = await provisionTripAndMember({ ownerUserId: aliceId }));
  await db.insert(tripMembers).values({ tripId: consentedTripId, userId: bobId, role: "MEMBER" });

  // Only the first trip may see the accommodation style.
  await db.insert(consentGrants).values({
    tripId: consentedTripId,
    userId: aliceId,
    scope: "PROFILE_PREFERENCES",
    fieldList: ["accommodation_style"],
    granted: true,
  });
});

afterAll(async () => {
  await db.delete(sharedTrips).where(eq(sharedTrips.id, thirdTripId));
});

describe("TS-H1e step 1 — behaviour raises a suggestion, never a fact", () => {
  it("surfaces a candidate only once every gate is satisfied", async () => {
    const result = await recordQualifyingEvidence();
    expect(result).toMatchObject({ outcome: "AGGREGATED", surfaceable: true });
    expect(await listSurfaceableProposals(aliceId, { now: at(30) })).toHaveLength(1);
  });

  it("does not create a fact from evidence alone", async () => {
    await recordQualifyingEvidence();

    // The whole asymmetry of the design: behaviour may only ever suggest.
    expect(await listActiveFacts(aliceId)).toHaveLength(0);
  });

  it("keeps no chat, action type, path or event reference on the proposal", async () => {
    await recordQualifyingEvidence();
    const [row] = await db.select().from(memoryProposals)
      .where(eq(memoryProposals.userId, aliceId));

    // A behaviour timeline is exactly what must not be reconstructable, so the
    // stored columns are pinned rather than merely spot-checked.
    expect(Object.keys(row).sort()).toEqual([
      "contributingTripIds", "cooldownUntil", "createdAt", "distinctEpisodeCount",
      "distinctTripCount", "expiresAt", "fieldKey", "firstObservedOn", "id",
      "lastObservedOn", "observationCount", "profileId", "proposedValue",
      "proposedValueHash", "recentObservedOn", "resolvedAt", "resolvedFactId",
      "scoringVersion", "source", "status", "updatedAt", "userId",
    ]);
    expect(row.recentObservedOn.length)
      .toBeLessThanOrEqual(MEMORY_ACTIVATION_POLICY_V1.recentDepth);
  });
});

describe("TS-H1e step 1a/1b — partial evidence and replays", () => {
  it("does not surface evidence confined to a single trip", async () => {
    await observe({ tripId: consentedTripId, dayOffset: 0 });
    await observe({ tripId: consentedTripId, dayOffset: 15 });
    const third = await observe({ tripId: consentedTripId, dayOffset: 30 });
    expect(third).toMatchObject({ surfaceable: false, blockedBy: "TRIPS" });
  });

  it("does not surface evidence spanning under 30 days", async () => {
    await observe({ tripId: consentedTripId, dayOffset: 0 });
    await observe({ tripId: unconsentedTripId, dayOffset: 5 });
    const third = await observe({ tripId: thirdTripId, dayOffset: 10 });
    expect(third).toMatchObject({ surfaceable: false, blockedBy: "SPAN" });
  });

  it("does not surface two candidates within ln(2) of each other", async () => {
    await recordQualifyingEvidence("budget");
    await recordQualifyingEvidence("luxury");

    // A field with two near-equal candidates has no winner to offer; evidence
    // keeps aggregating instead.
    expect(await listSurfaceableProposals(aliceId, { now: at(30) })).toHaveLength(0);
  });

  it("does not count a replayed episode id but counts two on one day", async () => {
    await observe({ episodeId: "replayed", dayOffset: 0 });
    const replay = await observe({ episodeId: "replayed", dayOffset: 3 });
    expect(replay).toEqual({ outcome: "DUPLICATE_EPISODE" });

    await observe({ episodeId: "morning", dayOffset: 7 });
    await observe({ episodeId: "evening", dayOffset: 7 });
    expect((await listPendingProposals(aliceId))[0].observationCount).toBe(3);
  });
});

describe("TS-H1e step 2 — confirmation, edit and deletion are the owner's", () => {
  it("turns a confirmed proposal into an active fact", async () => {
    await recordQualifyingEvidence();
    const [proposal] = await listSurfaceableProposals(aliceId, { now: at(30) });

    await confirmProposal({ ctx, userId: aliceId, proposalId: proposal.id, now: at(30) });
    const facts = await listActiveFacts(aliceId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ fieldKey: "accommodation_style", value: "budget" });
  });

  it("clears the observation window once a proposal reaches a terminal state", async () => {
    await recordQualifyingEvidence();
    const [proposal] = await listSurfaceableProposals(aliceId, { now: at(30) });
    await dismissProposal({ ctx, userId: aliceId, proposalId: proposal.id });

    const [row] = await db.select().from(memoryProposals)
      .where(eq(memoryProposals.id, proposal.id));
    expect(row.recentObservedOn).toEqual([]);
    expect(row.contributingTripIds).toEqual([]);
  });

  it("suppresses the same field and value for the cooldown after a dismissal", async () => {
    await recordQualifyingEvidence();
    const [proposal] = await listSurfaceableProposals(aliceId, { now: at(30) });
    await dismissProposal({ ctx, userId: aliceId, proposalId: proposal.id });

    // Re-observing the dismissed value must not immediately re-ask.
    expect(await observe({ dayOffset: 31 })).toEqual({ outcome: "IN_COOLDOWN" });
  });

  it("clears conflicting pending proposals when the fact is edited directly", async () => {
    await recordQualifyingEvidence();
    expect(await listPendingProposals(aliceId)).toHaveLength(1);

    // What the Profile form does: state the fact, and drop the suggestion that
    // was about to ask the question Alice has now answered.
    await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "accommodation_style", value: "luxury", path: "PROFILE_FORM",
    });
    await clearPendingProposalsForField({
      ctx, userId: aliceId, fieldKey: "accommodation_style",
    });

    expect(await listPendingProposals(aliceId)).toHaveLength(0);
  });

  it("removes a deleted fact from future projections", async () => {
    const fact = await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });
    expect(await deleteFact({ ctx, userId: aliceId, factId: fact.id })).toBe(true);
    expect(await listActiveFacts(aliceId)).toHaveLength(0);
  });

  it("does not let another member confirm or delete Alice's memory", async () => {
    await recordQualifyingEvidence();
    const [proposal] = await listSurfaceableProposals(aliceId, { now: at(30) });

    // Scoped by owner, so Bob's attempt cannot even see the row to resolve.
    expect(await confirmProposal({ ctx, userId: bobId, proposalId: proposal.id, now: at(30) }))
      .toEqual({ outcome: "NOT_FOUND" });
    expect(await listPendingProposals(aliceId)).toHaveLength(1);
  });
});

describe("TS-H1e step 3 — sensitive fields fail closed", () => {
  it("refuses to aggregate any sensitive field from behaviour", async () => {
    for (const [fieldKey, value] of [
      ["nationality", "Singapore"],
      ["date_of_birth", "1990-01-01"],
      ["mobility_notes", "step-free access"],
    ] as const) {
      expect(await observe({ fieldKey, value })).toEqual({
        outcome: "REJECTED", reason: "SENSITIVE_FIELD",
      });
    }
    // Not merely unshown — no row exists for a pipeline to later surface.
    expect(await db.select().from(memoryProposals)
      .where(eq(memoryProposals.userId, aliceId))).toHaveLength(0);
  });
});

describe("TS-H1e step 4 — trip memory is scoped to its trip", () => {
  it("does not leak a this-trip override into another trip", async () => {
    await saveOverride({
      ctx, tripId: consentedTripId, userId: aliceId,
      fieldKey: "trip_pace", value: "packed",
    });

    expect(await listOverridesForOwner(consentedTripId, aliceId)).toHaveLength(1);
    expect(await listOverridesForOwner(unconsentedTripId, aliceId)).toHaveLength(0);
  });

  it("does not leak a group decision into another trip", async () => {
    await saveGroupDecision({
      ctx, tripId: consentedTripId, userId: aliceId,
      fieldKey: "accommodation_style", value: "budget",
    });

    expect(await listGroupDecisions(consentedTripId, aliceId)).toHaveLength(1);
    expect(await listGroupDecisions(unconsentedTripId, aliceId)).toHaveLength(0);
  });

  it("does not show one member another member's override", async () => {
    await saveOverride({
      ctx, tripId: consentedTripId, userId: aliceId,
      fieldKey: "trip_pace", value: "packed",
    });

    // Bob is a member of this trip, which is not the same as being able to
    // read what Alice privately set for it.
    expect(await listOverridesForOwner(consentedTripId, bobId)).toHaveLength(0);
  });

  it("leaves the trip's own memory untouched when a member deletes theirs", async () => {
    const override = await saveOverride({
      ctx, tripId: consentedTripId, userId: aliceId,
      fieldKey: "trip_pace", value: "packed",
    });
    await saveGroupDecision({
      ctx, tripId: consentedTripId, userId: aliceId,
      fieldKey: "accommodation_style", value: "budget",
    });

    await deleteTripMemory({ ctx, tripId: consentedTripId, userId: aliceId, factId: override.id });
    expect(await listGroupDecisions(consentedTripId, aliceId)).toHaveLength(1);
  });
});

describe("TS-H1e steps 5/6 — the projection is the only shared path", () => {
  async function projectionFor(tripId: string) {
    const facts = await db.select().from(preferenceFacts).where(and(
      eq(preferenceFacts.userId, aliceId),
      eq(preferenceFacts.status, "ACTIVE"),
    ));
    const grants = await db.select().from(consentGrants).where(and(
      eq(consentGrants.tripId, tripId),
      eq(consentGrants.granted, true),
    ));
    const tripFacts = await db.select().from(tripConstraintFacts).where(and(
      eq(tripConstraintFacts.tripId, tripId),
      eq(tripConstraintFacts.status, "ACTIVE"),
    ));

    const consentedFieldsByUser: Record<string, string[]> = {};
    for (const grant of grants) {
      (consentedFieldsByUser[grant.userId] ??= []).push(...(grant.fieldList ?? []));
    }

    return buildMemoryNamespace({
      aliases: { [aliceId]: "m-alice", [bobId]: "m-bob" },
      consentedFieldsByUser,
      preferenceFacts: facts.map((f) => ({
        userId: f.userId, fieldKey: f.fieldKey, value: f.fieldValue,
      })),
      tripFacts: tripFacts.map((f) => ({
        ownerUserId: f.ownerUserId, fieldKey: f.fieldKey,
        kind: f.kind, valueJson: f.valueJson,
      })),
    });
  }

  it("exports a fact to the consenting trip and withholds it from the other", async () => {
    await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });

    expect((await projectionFor(consentedTripId)).members["m-alice"].profileFacts)
      .toEqual({ accommodation_style: "budget" });
    // Same fact, same member, a trip that never consented.
    expect((await projectionFor(unconsentedTripId)).members["m-alice"].profileFacts)
      .toEqual({});
  });

  it("stops exporting once consent is revoked", async () => {
    await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });
    await db.update(consentGrants).set({ granted: false })
      .where(eq(consentGrants.tripId, consentedTripId));

    expect((await projectionFor(consentedTripId)).members["m-alice"].profileFacts).toEqual({});
  });

  it("gives the Shared Agent no route to a proposal or an unconsented fact", async () => {
    await recordQualifyingEvidence();
    await replaceFact({
      ctx, userId: aliceId, profileId: aliceProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });

    // `trip_pace` is exportable but unconsented here, and a pending proposal is
    // not shared data at all. Neither may appear in what a skill can read.
    const projection = readMemoryProjection({ _meta: { memory: await projectionFor(consentedTripId) } });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("trip_pace");
    expect(serialized).not.toContain("PENDING");
    expect(serialized).not.toContain(aliceId);
  });
});
