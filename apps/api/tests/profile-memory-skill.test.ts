/**
 * `profile.memory` is bound to the authenticated actor.
 *
 * Skill input is written by the model. The owner therefore cannot be an input
 * field: it would let the model express "read this other person's long-term
 * memory", and the only thing standing in the way would be a comment saying it
 * always passes the caller.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  auditEvents,
  memoryProposals,
  preferenceFacts,
  userProfiles,
  users,
} from "../src/db/schema.js";
import { profileMemorySkill } from "../src/skills/personal/profile-memory-skill.js";
import { replaceFact } from "../src/services/preference-fact-service.js";
import { createRequestContext } from "../src/utils/context.js";
import type { SkillContext } from "../src/agents/contracts.js";

let aliceId: string;
let bobId: string;
let aliceProfileId: string;
let bobProfileId: string;

async function ensureUser(externalId: string): Promise<{ userId: string; profileId: string }> {
  const [created] = await db.insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  const userId = created
    ? created.id
    : (await db.select().from(users).where(eq(users.externalId, externalId)).limit(1))[0]!.id;

  const [profile] = await db.insert(userProfiles)
    .values({ userId, displayName: externalId })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  const profileId = profile
    ? profile.id
    : (await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1))[0]!.id;

  return { userId, profileId };
}

function contextFor(userId: string | undefined): SkillContext {
  return {
    ctx: userId ? createRequestContext(userId) : createRequestContext(),
    policyGate: {} as SkillContext["policyGate"],
  };
}

const run = (userId: string | undefined, input: Record<string, unknown> = {}) =>
  profileMemorySkill.handler(
    contextFor(userId),
    profileMemorySkill.input.parse(input),
    new AbortController().signal,
  );

beforeAll(async () => {
  ({ userId: aliceId, profileId: aliceProfileId } = await ensureUser("skill-alice"));
  ({ userId: bobId, profileId: bobProfileId } = await ensureUser("skill-bob"));
});

afterAll(async () => {
  const ids = [aliceId, bobId];
  await db.delete(memoryProposals).where(inArray(memoryProposals.userId, ids));
  await db.delete(preferenceFacts).where(inArray(preferenceFacts.userId, ids));
  await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, ids));
});

beforeEach(async () => {
  const ids = [aliceId, bobId];
  await db.delete(preferenceFacts).where(inArray(preferenceFacts.userId, ids));
  await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, ids));

  const ctx = createRequestContext(aliceId);
  await replaceFact({
    ctx, userId: aliceId, profileId: aliceProfileId,
    fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM",
  });
  await replaceFact({
    ctx: createRequestContext(bobId), userId: bobId, profileId: bobProfileId,
    fieldKey: "accommodation_style", value: "luxury", path: "PROFILE_FORM",
  });
});

describe("profile.memory owner binding", () => {
  it("returns the authenticated caller's own facts", async () => {
    const result = await run(aliceId);
    expect(result.items).toEqual([expect.objectContaining({
      field: "trip_pace", value: "relaxed",
    })]);
  });

  it("does not accept an owner as input", () => {
    // The schema is strict, so naming someone else is rejected outright rather
    // than silently ignored — a caller that tried is told, not quietly served
    // its own data.
    expect(() => profileMemorySkill.input.parse({ userId: bobId }))
      .toThrow();
  });

  it("cannot be steered to another user's memory", async () => {
    // Even if the extra key survived parsing, the handler never reads it.
    const result = await profileMemorySkill.handler(
      contextFor(aliceId),
      { userId: bobId, fields: [], includeSuggestions: false } as never,
      new AbortController().signal,
    );

    expect(result.items).toEqual([expect.objectContaining({ field: "trip_pace" })]);
    expect(JSON.stringify(result)).not.toContain("luxury");
  });

  it("refuses to run without an authenticated actor", async () => {
    // No default owner, no empty result: an unauthenticated invocation is a
    // bug, and returning nothing would hide it.
    await expect(run(undefined)).rejects.toThrow(/authenticated actor/);
  });

  it("gives each caller only their own facts", async () => {
    const forBob = await run(bobId);
    expect(forBob.items).toEqual([expect.objectContaining({
      field: "accommodation_style", value: "luxury",
    })]);
  });
});
