import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  chatMessages,
  chatThreads,
  destinationCueBatches,
  sharedTrips,
  tripMembers,
  users,
} from "../src/db/schema.js";
import { persistDestinationCue } from "../src/services/destination-cue-service.js";
import { provisionTripAndMember } from "./helpers/trip.js";
import type { AgentTaskRow } from "../src/tasks/task-repository.js";

let aliceId: string;

beforeAll(async () => {
  const [existing] = await db.select().from(users).where(eq(users.externalId, "alice")).limit(1);
  aliceId = existing?.id ?? (await db.insert(users)
    .values({ externalId: "alice", displayName: "Alice" }).returning())[0].id;
});

beforeEach(async () => {
  await db.delete(auditEvents);
  await db.delete(agentTaskRuns);
  await db.delete(chatMessages);
  await db.delete(chatThreads);
  await db.delete(tripMembers);
  await db.delete(sharedTrips);
});

async function draftTripWith(destinations: string[]): Promise<{ tripId: string; run: AgentTaskRow }> {
  const { tripId } = await provisionTripAndMember({ ownerUserId: aliceId });
  await db.update(sharedTrips)
    .set({ status: "DRAFT", destinationCandidates: destinations })
    .where(eq(sharedTrips.id, tripId));
  const [thread] = await db.insert(chatThreads).values({
    tripId, ownerUserId: aliceId, title: "Default", isDefault: true,
  }).returning();
  // The CHECK on `agent_task_runs` requires a CONVERSATION run to point at a
  // user message, so the turn that mentioned the place has to exist.
  const [message] = await db.insert(chatMessages).values({
    threadId: thread.id,
    senderUserId: aliceId,
    role: "USER",
    body: "下吕怎么样",
    markedSharedByOwner: false,
    redactedSummary: null,
  }).returning();
  const [run] = await db.insert(agentTaskRuns).values({
    operation: "CONVERSATION",
    status: "QUEUED",
    createdByUserId: aliceId,
    threadId: thread.id,
    tripId,
    requestId: randomUUID(),
    userMessageId: message.id,
    contextMaxMessageSequence: message.messageSequence,
    expiresAt: new Date(Date.now() + 300_000),
  }).returning();
  return { tripId, run };
}

function decision(names: string[]) {
  return {
    candidates: names.map((canonicalCityName, ordinal) => ({
      ordinal,
      canonicalCityName,
      countryCode: "JP",
      candidateKeyHash: "a".repeat(63) + String(ordinal),
    })),
    modelVersion: "test-model",
    promptVersion: "test-prompt",
  };
}

/**
 * A destination the traveller already accepted must not come back as a
 * question.
 *
 * Eligibility was checked against `destination_cue_suppressions` alone, and
 * only *dismissing* a cue writes a row there — accepting one writes none. So
 * saving Gero and then mentioning Gero again raised the same card a second
 * time, asking 「要将 Gero 设为目的地吗？」 of someone who had answered exactly
 * that. The decision skill is handed `currentDestinations`, but a model being
 * told something is not the same as the server enforcing it.
 */
describe("destination cue — already on the trip", () => {
  it("raises no cue for a destination the trip already holds", async () => {
    const { run } = await draftTripWith(["Gero"]);

    const cue = await persistDestinationCue({ run, decision: decision(["Gero"]) });

    expect(cue).toBeNull();
    // Not merely hidden: no batch is written at all.
    expect(await db.select().from(destinationCueBatches)).toHaveLength(0);
  });

  it("matches the accept path's comparison rather than a stricter one", async () => {
    // The accept path treats these as the same place, so the cue must too —
    // one deciding a name is new while the other calls it a duplicate is how a
    // cue gets raised for a destination that is then silently discarded.
    const { run } = await draftTripWith(["gero"]);

    expect(await persistDestinationCue({ run, decision: decision(["Gero"]) })).toBeNull();
  });

  it("still raises a cue for a genuinely new destination", async () => {
    const { run } = await draftTripWith(["Gero"]);

    const cue = await persistDestinationCue({ run, decision: decision(["Kyoto"]) });

    expect(cue?.candidates.map((candidate) => candidate.displayName)).toEqual(["Kyoto"]);
  });

  it("keeps the new destinations from a batch that also repeats a settled one", async () => {
    const { run } = await draftTripWith(["Gero"]);

    const cue = await persistDestinationCue({ run, decision: decision(["Gero", "Kyoto"]) });

    expect(cue?.candidates.map((candidate) => candidate.displayName)).toEqual(["Kyoto"]);
  });

  it("raises every candidate when the trip has settled none", async () => {
    const { run } = await draftTripWith([]);

    const cue = await persistDestinationCue({ run, decision: decision(["Gero", "Kyoto"]) });

    expect(cue?.candidates).toHaveLength(2);
  });
});
