import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { db } from "../src/db/database.js";
import {
  agentTaskRuns,
  auditEvents,
  chatMessages,
  chatThreads,
  destinationCueBatches,
  destinationCueCandidates,
  destinationCuePromptPolicies,
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
  // This suite shares a disposable schema with provider tests. Cascading from
  // the Trip root clears snapshots/offers in FK order and keeps this focused
  // test independent of whichever suite ran immediately before it.
  await db.execute(sql`TRUNCATE TABLE shared_trips CASCADE`);
  await db.delete(auditEvents);
  await db.delete(agentTaskRuns);
  await db.delete(chatMessages);
  await db.delete(chatThreads);
  await db.delete(tripMembers);
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

async function nextRunFor(run: AgentTaskRow): Promise<AgentTaskRow> {
  await db.update(agentTaskRuns).set({ status: "COMPLETED", finishedAt: new Date() })
    .where(eq(agentTaskRuns.id, run.id));
  const [message] = await db.insert(chatMessages).values({
    threadId: run.threadId!,
    senderUserId: run.createdByUserId,
    role: "USER",
    body: "京都，就这个",
    markedSharedByOwner: false,
    redactedSummary: null,
  }).returning();
  const [nextRun] = await db.insert(agentTaskRuns).values({
    operation: "CONVERSATION",
    status: "QUEUED",
    createdByUserId: run.createdByUserId,
    threadId: run.threadId!,
    tripId: run.tripId!,
    requestId: randomUUID(),
    userMessageId: message.id,
    contextMaxMessageSequence: message.messageSequence,
    expiresAt: new Date(Date.now() + 300_000),
  }).returning();
  return nextRun;
}

function decision(
  names: string[],
  intent: "DESTINATION_INTEREST" | "EXPLICIT_SET_DESTINATION" = "EXPLICIT_SET_DESTINATION",
) {
  return {
    candidates: names.map((canonicalCityName, ordinal) => ({
      ordinal,
      canonicalCityName,
      countryCode: "JP",
      candidateKeyHash: "a".repeat(63) + String(ordinal),
      intent,
      triggerContext: intent === "EXPLICIT_SET_DESTINATION"
        ? "EXPLICIT_DESTINATION_COMMAND" as const
        : "CITY_EXPLORATION" as const,
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
    const { tripId, run } = await draftTripWith(["Gero"]);

    const cue = await persistDestinationCue({ run, decision: decision(["Gero"]) });

    expect(cue).toBeNull();
    // Not merely hidden: no batch is written for this trip at all. Scoped to
    // the trip rather than the table — this database is shared with every
    // sibling file, so a global count is somebody else's rows.
    expect(await db.select().from(destinationCueBatches)
      .where(eq(destinationCueBatches.tripId, tripId))).toHaveLength(0);
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

  it("keeps the existing OPEN card when a later turn names the same city", async () => {
    const { tripId, run } = await draftTripWith([]);
    const first = await persistDestinationCue({ run, decision: decision(["Kyoto"]) });
    const second = await persistDestinationCue({
      run: await nextRunFor(run),
      decision: decision(["Kyoto"]),
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await db.select().from(destinationCueBatches)
      .where(eq(destinationCueBatches.tripId, tripId))).toHaveLength(1);
  });
});

/**
 * Declining a city is a statement about that city. It used to be stored as a
 * thirty-minute cooldown on `(owner, trip)`, so turning down one suggestion
 * silenced every other city too: the traveller named a different place and
 * nothing appeared, and only an explicit "把北京设为目的地" still worked.
 */
describe("destination cue — a dismissal is about the city it dismissed", () => {
  const DISMISSED_AT = new Date("2026-09-04T08:00:00.000Z");
  const SOON_AFTER = new Date("2026-09-04T08:10:00.000Z");
  const AFTER_COOLDOWN = new Date("2026-09-04T08:31:00.000Z");

  async function tripWithDismissedKyoto() {
    const { run } = await draftTripWith([]);
    const raised = await persistDestinationCue({
      run,
      decision: decision(["Kyoto"], "DESTINATION_INTEREST"),
      now: DISMISSED_AT,
    });
    expect(raised).not.toBeNull();
    await db.update(destinationCueCandidates)
      .set({ status: "DISMISSED", resolvedAt: DISMISSED_AT })
      .where(eq(destinationCueCandidates.canonicalCityName, "Kyoto"));
    return { run };
  }

  it("does not ask about the declined city again straight away", async () => {
    const { run } = await tripWithDismissedKyoto();
    expect(await persistDestinationCue({
      run: await nextRunFor(run),
      decision: decision(["Kyoto"], "DESTINATION_INTEREST"),
      now: SOON_AFTER,
    })).toBeNull();
  });

  it("still asks about a different city", async () => {
    const { run } = await tripWithDismissedKyoto();
    const cue = await persistDestinationCue({
      run: await nextRunFor(run),
      decision: decision(["Osaka"], "DESTINATION_INTEREST"),
      now: SOON_AFTER,
    });
    expect(cue?.candidates.map((candidate) => candidate.displayName)).toEqual(["Osaka"]);
  });

  it("lets an explicit set command through for the declined city itself", async () => {
    const { run } = await tripWithDismissedKyoto();
    const cue = await persistDestinationCue({
      run: await nextRunFor(run),
      decision: decision(["Kyoto"], "EXPLICIT_SET_DESTINATION"),
      now: SOON_AFTER,
    });
    expect(cue?.candidates.map((candidate) => candidate.displayName)).toEqual(["Kyoto"]);
  });

  it("asks again once the half hour is up", async () => {
    const { run } = await tripWithDismissedKyoto();
    const cue = await persistDestinationCue({
      run: await nextRunFor(run),
      decision: decision(["Kyoto"], "DESTINATION_INTEREST"),
      now: AFTER_COOLDOWN,
    });
    expect(cue?.candidates.map((candidate) => candidate.displayName)).toEqual(["Kyoto"]);
  });

  it("still stops at the day's third dismissal, whatever the city", async () => {
    const { tripId, run } = await draftTripWith([]);
    await db.insert(destinationCuePromptPolicies).values({
      ownerUserId: aliceId,
      tripId,
      dismissalDay: "2026-09-04",
      dailyDismissalCount: 3,
      timezone: "UTC",
    });
    expect(await persistDestinationCue({
      run,
      decision: decision(["Osaka"], "DESTINATION_INTEREST"),
      now: SOON_AFTER,
    })).toBeNull();
  });
});
