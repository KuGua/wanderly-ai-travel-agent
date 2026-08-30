import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  auditEvents,
  consentGrants,
  preferenceFacts,
  sharedTrips,
  tripConstraintFacts,
  tripMembers,
  userProfiles,
  users,
} from "../src/db/schema.js";
import { replaceFact } from "../src/services/preference-fact-service.js";
import { saveOverride } from "../src/services/trip-memory-service.js";
import {
  computeMemorySourceFingerprint,
  fingerprintFromSnapshot,
} from "../src/services/memory-source-fingerprint.js";

const ctx = { correlationId: "00000000-0000-4000-8000-0000000000ff", actorUserId: undefined } as never;

let ownerId: string;
let profileId: string;
let tripId: string;

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
  if (ownerId) {
    await db.delete(auditEvents).where(eq(auditEvents.actorUserId, ownerId));
    await db.delete(preferenceFacts).where(eq(preferenceFacts.userId, ownerId));
  }
  if (tripId) {
    await db.delete(auditEvents).where(inArray(auditEvents.tripId, [tripId]));
    await db.delete(tripConstraintFacts).where(eq(tripConstraintFacts.tripId, tripId));
    await db.delete(consentGrants).where(eq(consentGrants.tripId, tripId));
    await db.delete(tripMembers).where(eq(tripMembers.tripId, tripId));
    await db.delete(sharedTrips).where(eq(sharedTrips.id, tripId));
  }
}

const fingerprint = () => computeMemorySourceFingerprint({ tripId, memberUserIds: [ownerId] });

beforeAll(async () => {
  ownerId = await ensureUser("fingerprint-owner");
  const [profile] = await db.insert(userProfiles)
    .values({ userId: ownerId, displayName: "Owner" })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  profileId = profile
    ? profile.id
    : (await db.select().from(userProfiles).where(eq(userProfiles.userId, ownerId)).limit(1))[0]!.id;
});

afterAll(cleanup);

beforeEach(async () => {
  await cleanup();
  const [trip] = await db.insert(sharedTrips).values({
    name: "Fingerprint Trip",
    createdBy: ownerId,
    departureCities: ["Shanghai"],
    destinationCandidates: ["Tokyo", "Kyoto"],
  }).returning();
  tripId = trip.id;
  await db.insert(tripMembers).values({ tripId, userId: ownerId, role: "CREATOR" });
  await db.insert(consentGrants).values({
    tripId,
    userId: ownerId,
    scope: "PROFILE_PREFERENCES",
    fieldList: ["trip_pace"],
    granted: true,
  });
});

describe("computeMemorySourceFingerprint", () => {
  it("is stable when nothing changes", async () => {
    expect(await fingerprint()).toBe(await fingerprint());
  });

  it("changes when a preference fact is created", async () => {
    const before = await fingerprint();
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });
    expect(await fingerprint()).not.toBe(before);
  });

  it("changes when a preference fact is edited", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });
    const before = await fingerprint();

    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "trip_pace", value: "packed", path: "PROFILE_FORM",
    });
    expect(await fingerprint()).not.toBe(before);
  });

  it("changes when consent is revoked", async () => {
    const before = await fingerprint();
    // Consent decides what may be projected at all, so revoking it must
    // invalidate a run even though no fact moved.
    await db.update(consentGrants).set({ granted: false }).where(eq(consentGrants.tripId, tripId));
    expect(await fingerprint()).not.toBe(before);
  });

  it("changes when the consented field list narrows", async () => {
    const before = await fingerprint();
    await db.update(consentGrants).set({ fieldList: [] }).where(eq(consentGrants.tripId, tripId));
    expect(await fingerprint()).not.toBe(before);
  });

  it("changes when a trip override is saved", async () => {
    const before = await fingerprint();
    await saveOverride({
      ctx, tripId, userId: ownerId, fieldKey: "trip_pace", value: "packed",
    });
    expect(await fingerprint()).not.toBe(before);
  });

  it("changes when a trip override is replaced", async () => {
    await saveOverride({ ctx, tripId, userId: ownerId, fieldKey: "trip_pace", value: "packed" });
    const before = await fingerprint();

    await saveOverride({ ctx, tripId, userId: ownerId, fieldKey: "trip_pace", value: "relaxed" });
    expect(await fingerprint()).not.toBe(before);
  });

  it("does not depend on row ordering", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });

    // Two reads of the same state must agree even though the database is free
    // to return rows in any order.
    expect(await fingerprint()).toBe(await fingerprint());
  });

  it("never embeds a memory value", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });
    // It lands in the snapshot, which is readable by anyone who can read a
    // plan, so it must reveal nothing about what a member prefers.
    const value = await fingerprint();
    expect(value).toMatch(/^[0-9a-f]{32}$/);
    expect(value).not.toContain("relaxed");
  });
});

describe("member resolution", () => {
  it("differs between an empty member list and the trip's real members", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });

    // The Worker passes no member ids, meaning "everyone on the trip". The
    // snapshot resolves that to the real members; a caller that hashes the
    // empty list instead gets a different value and fails its own guard. This
    // is why resolution is shared rather than repeated — see
    // `resolveMemberIds` in planning-service.
    const overEveryone = await computeMemorySourceFingerprint({
      tripId, memberUserIds: [ownerId],
    });
    const overNobody = await computeMemorySourceFingerprint({
      tripId, memberUserIds: [],
    });
    expect(overNobody).not.toBe(overEveryone);
  });
});

describe("fingerprintFromSnapshot", () => {
  it("reads the value recorded under _meta", () => {
    expect(fingerprintFromSnapshot({ _meta: { memorySourceFingerprint: "abc" } })).toBe("abc");
  });

  it("returns null for a snapshot taken before the guard existed", () => {
    // Older snapshots have no fingerprint; the commit gate skips rather than
    // failing every legacy plan.
    expect(fingerprintFromSnapshot({ _meta: { schemaVersion: 2 } })).toBeNull();
    expect(fingerprintFromSnapshot({})).toBeNull();
    expect(fingerprintFromSnapshot(null)).toBeNull();
  });
});
