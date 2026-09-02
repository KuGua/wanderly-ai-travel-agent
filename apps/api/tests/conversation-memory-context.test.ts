import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import { auditEvents, preferenceFacts, userProfiles, users } from "../src/db/schema.js";
import { replaceFact } from "../src/services/preference-fact-service.js";
import {
  CONVERSATION_MEMORY_MAX_FACTS,
  buildConversationMemoryContext,
} from "../src/services/conversation-memory-context.js";

const ctx = { correlationId: "00000000-0000-4000-8000-0000000000cc", actorUserId: undefined } as never;

let ownerId: string;
let otherId: string;
let ownerProfileId: string;
let otherProfileId: string;

async function ensureUser(externalId: string): Promise<string> {
  const [created] = await db.insert(users)
    .values({ externalId, displayName: externalId })
    .onConflictDoNothing({ target: users.externalId })
    .returning();
  if (created) return created.id;
  const [existing] = await db.select().from(users).where(eq(users.externalId, externalId)).limit(1);
  return existing!.id;
}

async function ensureProfile(userId: string, name: string): Promise<string> {
  const [created] = await db.insert(userProfiles)
    .values({ userId, displayName: name })
    .onConflictDoNothing({ target: userProfiles.userId })
    .returning();
  if (created) return created.id;
  const [existing] = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
  return existing!.id;
}

async function cleanup() {
  const ids = [ownerId, otherId].filter(Boolean);
  if (ids.length === 0) return;
  await db.delete(preferenceFacts).where(inArray(preferenceFacts.userId, ids));
  await db.delete(auditEvents).where(inArray(auditEvents.actorUserId, ids));
}

beforeAll(async () => {
  ownerId = await ensureUser("conversation-memory-owner");
  otherId = await ensureUser("conversation-memory-other");
  ownerProfileId = await ensureProfile(ownerId, "Owner");
  otherProfileId = await ensureProfile(otherId, "Other");
});
afterAll(cleanup);
beforeEach(cleanup);

describe("what long-term memory hands the model", () => {
  it("carries the owner's own preferences, with the category the model reasons about", async () => {
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM" });
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "no_red_eye", value: true, path: "PROPOSAL_CONFIRMATION" });

    const facts = await buildConversationMemoryContext(ownerId);

    expect(facts).toEqual([
      { field: "no_red_eye", value: true, category: "CONSTRAINT", source: "PROPOSAL_CONFIRMATION" },
      { field: "trip_pace", value: "relaxed", category: "PREFERENCE", source: "PROFILE_FORM" },
    ]);
  });

  it("withholds the fields only the profile form may write", async () => {
    // Nationality, date of birth and mobility notes are FORM_ONLY. The
    // catalogue states the write rule and is silent on reads; sending them to
    // a third-party model on every turn is a wider exposure than storing them.
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "nationality", value: "CN", path: "PROFILE_FORM" });
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "date_of_birth", value: "1990-01-01", path: "PROFILE_FORM" });
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "mobility_notes", value: "step-free access", path: "PROFILE_FORM" });
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM" });

    const facts = await buildConversationMemoryContext(ownerId);

    expect(facts.map((fact) => fact.field)).toEqual(["trip_pace"]);
    expect(JSON.stringify(facts)).not.toContain("CN");
    expect(JSON.stringify(facts)).not.toContain("1990");
    expect(JSON.stringify(facts)).not.toContain("step-free");
  });

  it("never hands over another traveller's memory", async () => {
    await replaceFact({ ctx, userId: otherId, profileId: otherProfileId, fieldKey: "trip_pace", value: "packed", path: "PROFILE_FORM" });
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM" });

    const facts = await buildConversationMemoryContext(ownerId);

    expect(facts).toHaveLength(1);
    expect(facts[0].value).toBe("relaxed");
  });

  it("drops a row whose field the catalogue no longer vouches for", async () => {
    // Rows outlive catalogue entries. A field the catalogue has forgotten has
    // no sensitivity to check, so it cannot be shown to be safe to send.
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM" });
    await db.update(preferenceFacts)
      .set({ fieldKey: "retired_field" })
      .where(eq(preferenceFacts.userId, ownerId));

    expect(await buildConversationMemoryContext(ownerId)).toEqual([]);
  });

  it("orders by field, so an unchanged memory produces an unchanged prompt", async () => {
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM" });
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "accommodation_style", value: "luxury", path: "PROFILE_FORM" });
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "interests", value: ["jazz"], path: "PROFILE_FORM" });

    const first = await buildConversationMemoryContext(ownerId);
    const second = await buildConversationMemoryContext(ownerId);

    expect(first.map((fact) => fact.field)).toEqual(["accommodation_style", "interests", "trip_pace"]);
    expect(second).toEqual(first);
  });

  it("returns nothing at all for a traveller who has told it nothing", async () => {
    expect(await buildConversationMemoryContext(ownerId)).toEqual([]);
  });

  it("caps the prompt budget", async () => {
    // The catalogue is smaller than the cap today, so this pins the guard
    // rather than an expected truncation.
    expect(CONVERSATION_MEMORY_MAX_FACTS).toBe(16);
  });
});
