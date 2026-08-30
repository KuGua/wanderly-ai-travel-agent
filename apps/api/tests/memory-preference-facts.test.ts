import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import { auditEvents, memoryProposals, preferenceFacts, userProfiles, users } from "../src/db/schema.js";
import {
  MemoryFieldRejectedError,
  deleteFact,
  listActiveFacts,
  replaceFact,
} from "../src/services/preference-fact-service.js";
const ctx = { correlationId: "00000000-0000-4000-8000-0000000000aa", actorUserId: undefined } as never;

let ownerId: string;
let otherId: string;
let ownerProfileId: string;

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
}

beforeAll(async () => {
  ownerId = await ensureUser("memory-owner");
  otherId = await ensureUser("memory-other");

  const [profile] = await db.insert(userProfiles)
    .values({ userId: ownerId, displayName: "Owner" })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  ownerProfileId = profile
    ? profile.id
    : (await db.select().from(userProfiles).where(eq(userProfiles.userId, ownerId)).limit(1))[0]!.id;
});

afterAll(cleanup);
beforeEach(cleanup);

describe("PreferenceFactService", () => {
  it("stores an active fact from the profile form", async () => {
    const fact = await replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });

    expect(fact).toMatchObject({ fieldKey: "accommodation_style", value: "budget", status: "ACTIVE" });
    const active = await listActiveFacts(ownerId);
    expect(active).toHaveLength(1);
  });

  it("supersedes the previous version instead of updating in place", async () => {
    const first = await replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "accommodation_style", value: "budget", path: "PROFILE_FORM",
    });
    const second = await replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "accommodation_style", value: "luxury", path: "PROFILE_FORM",
    });

    expect(second.id).not.toBe(first.id);
    const active = await listActiveFacts(ownerId);
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("luxury");

    const rows = await db.select().from(preferenceFacts)
      .where(and(eq(preferenceFacts.userId, ownerId), eq(preferenceFacts.fieldKey, "accommodation_style")));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
  });

  it("refuses a sensitive field from a non-form path", async () => {
    await expect(replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "nationality", value: "Singapore", path: "PROPOSAL_CONFIRMATION",
    })).rejects.toBeInstanceOf(MemoryFieldRejectedError);
  });

  it("refuses an unregistered field", async () => {
    await expect(replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "shoe_size", value: 42, path: "PROFILE_FORM",
    })).rejects.toBeInstanceOf(MemoryFieldRejectedError);
  });

  it("keeps owners isolated", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });
    expect(await listActiveFacts(otherId)).toHaveLength(0);
  });

  it("hard-deletes the whole version chain so no value survives", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });
    const latest = await replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "trip_pace", value: "packed", path: "PROFILE_FORM",
    });

    expect(await deleteFact({ ctx, userId: ownerId, factId: latest.id })).toBe(true);

    const remaining = await db.select().from(preferenceFacts)
      .where(and(eq(preferenceFacts.userId, ownerId), eq(preferenceFacts.fieldKey, "trip_pace")));
    expect(remaining).toHaveLength(0);
  });

  it("will not delete another owner's fact", async () => {
    const fact = await replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
    });
    expect(await deleteFact({ ctx, userId: otherId, factId: fact.id })).toBe(false);
  });

  it("never writes a value into the audit summary", async () => {
    await replaceFact({
      ctx, userId: ownerId, profileId: ownerProfileId,
      fieldKey: "accommodation_style", value: "luxury", path: "PROFILE_FORM",
    });

    const events = await db.select().from(auditEvents)
      .where(eq(auditEvents.actorUserId, ownerId));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("luxury");
    expect(serialized).toContain("PREFERENCE_FACT_UPDATE");
  });
});
