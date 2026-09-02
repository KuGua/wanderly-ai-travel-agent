import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import { db } from "../src/db/database.js";
import { auditEvents, preferenceFacts, sharedTrips, tripConstraintFacts, tripMembers, userProfiles, users } from "../src/db/schema.js";
import { replaceFact } from "../src/services/preference-fact-service.js";
import { saveOverride } from "../src/services/trip-memory-service.js";
import {
  CONVERSATION_MEMORY_MAX_FACTS,
  CONVERSATION_MEMORY_MAX_NOTES,
  buildConversationMemoryContext,
} from "../src/services/conversation-memory-context.js";
import { travelConversationInputSchema } from "../src/skills/personal/travel-conversation-skill.js";

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

async function makeTrip(name: string): Promise<string> {
  const [trip] = await db.insert(sharedTrips).values({
    name: `ctx-${name}-${Date.now()}`, createdBy: ownerId,
    departureCities: ["Shanghai"], destinationCandidates: [name],
  }).returning();
  await db.insert(tripMembers).values({ tripId: trip.id, userId: ownerId, role: "CREATOR" });
  tripIds.push(trip.id);
  return trip.id;
}

let tripIds: string[] = [];

async function cleanup() {
  const ids = [ownerId, otherId].filter(Boolean);
  if (tripIds.length > 0) {
    // Facts and membership only. The trip rows are referenced by audit
    // events and search preferences; leaving them is cheaper than chasing
    // every foreign key, and their names are unique per run.
    await db.delete(tripConstraintFacts).where(inArray(tripConstraintFacts.tripId, tripIds));
    await db.delete(tripMembers).where(inArray(tripMembers.tripId, tripIds));
    tripIds = [];
  }
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

  it("lets a trip disagree with the profile without changing what other trips inherit", async () => {
    // The same traveller wants Beijing packed and Shanghai unhurried. Saying
    // so about Beijing must leave Shanghai alone — `trip_constraint_facts`
    // scopes an override to one trip by construction; what was missing was
    // that the conversation never read them at all.
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM" });
    const beijing = await makeTrip("Beijing");
    const shanghai = await makeTrip("Shanghai");
    await saveOverride({ ctx, tripId: beijing, userId: ownerId, fieldKey: "trip_pace", value: "packed" });

    const inBeijing = await buildConversationMemoryContext(ownerId, beijing);
    const inShanghai = await buildConversationMemoryContext(ownerId, shanghai);
    const noTrip = await buildConversationMemoryContext(ownerId);

    expect(inBeijing.find((fact) => fact.field === "trip_pace")).toEqual({
      field: "trip_pace", value: "packed", category: "PREFERENCE", source: "TRIP_OVERRIDE",
    });
    expect(inShanghai.find((fact) => fact.field === "trip_pace")?.value).toBe("relaxed");
    expect(noTrip.find((fact) => fact.field === "trip_pace")?.value).toBe("relaxed");
  });

  it("shows one value per field, never the profile's and the trip's together", async () => {
    // Both in front of the model would leave it to guess which applies.
    await replaceFact({ ctx, userId: ownerId, profileId: ownerProfileId, fieldKey: "trip_pace", value: "relaxed", path: "PROFILE_FORM" });
    const trip = await makeTrip("Kyoto");
    await saveOverride({ ctx, tripId: trip, userId: ownerId, fieldKey: "trip_pace", value: "packed" });

    const paces = (await buildConversationMemoryContext(ownerId, trip)).filter((fact) => fact.field === "trip_pace");
    expect(paces).toHaveLength(1);
  });

  it("carries a trip-only field the profile never set", async () => {
    const trip = await makeTrip("Osaka");
    await saveOverride({ ctx, tripId: trip, userId: ownerId, fieldKey: "accommodation_style", value: "budget" });

    expect((await buildConversationMemoryContext(ownerId, trip))
      .find((fact) => fact.field === "accommodation_style")?.value).toBe("budget");
  });

  it("never builds a context the Skill will refuse", () => {
    // The two caps live in different files and share one array. When the
    // Skill's bound was the typed cap alone, adding notes pushed a real
    // profile past it and every turn failed input validation — which the
    // traveller saw as a reply that never came.
    const built = Array.from(
      { length: CONVERSATION_MEMORY_MAX_FACTS + CONVERSATION_MEMORY_MAX_NOTES },
      () => ({ field: "note", value: "x", category: "PREFERENCE" as const, source: "HIGHLIGHT" as const }),
    );
    expect(travelConversationInputSchema.safeParse({
      question: "anything", memoryContext: built, threadContext: [],
    }).success).toBe(true);
  });

  it("caps the prompt budget", async () => {
    // The catalogue is smaller than the cap today, so this pins the guard
    // rather than an expected truncation.
    expect(CONVERSATION_MEMORY_MAX_FACTS).toBe(16);
  });
});
