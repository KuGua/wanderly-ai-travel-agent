/**
 * GET /trips/:tripId — `pinnedSession` projection ownership.
 *
 * `pinnedSession` projects `agent_task_runs.research_intent_draft`, which is
 * written by the owner-only personal-research CAS path on a CONVERSATION run
 * (`PUT /agent-runs/:runId/personal-research/answers` in
 * `routes/personal-research.ts`). Before Phase 0, any trip member could read
 * the projection via `GET /trips/:tripId` and see another member's draft —
 * a cross-user, cross-trip data leak from inside a trip-scoped endpoint.
 * Phase 0 narrows the projection so only `pinnedRun.createdByUserId
 * === request.user.id` sees the DTO; everyone else (other members,
 * non-members) gets `null`.
 *
 * Spec: docs/shared-plan-surface-implementation.md §3.2 M1, §10.1.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

import { buildApp } from "../src/app.js";
import { db } from "../src/db/database.js";
import {
  users,
  sharedTrips,
  tripMembers,
  agentTaskRuns,
  chatThreads,
  chatMessages,
  auditEvents,
  providerOffers,
  providerSearchRuns,
  itineraryPlans,
  visaReadinessChecks,
} from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { authHeaders, verifyTestAccessToken } from "./helpers/auth.js";

let app: FastifyInstance;
let aliceId: string;
let bobId: string;
// carolId is referenced only indirectly through `authHeaders("carol")`
// in the non-member test — keep the provisioning call here so the row
// exists, but the local binding is intentionally not read.

beforeAll(async () => {
  app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
  await app.ready();

  for (const subject of ["alice", "bob", "carol"] as const) {
    const [existing] = await db.select().from(users)
      .where(eq(users.externalId, subject)).limit(1);
    if (existing) {
      if (subject === "alice") aliceId = existing.id;
      if (subject === "bob") bobId = existing.id;
      continue;
    }
    const [created] = await db.insert(users).values({
      externalId: subject,
      displayName: subject.charAt(0).toUpperCase() + subject.slice(1),
    }).returning();
    if (subject === "alice") aliceId = created.id;
    if (subject === "bob") bobId = created.id;
  }
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // `chat_threads.trip_id` is NOT NULL with `ON DELETE SET NULL` (set by
  // migration 0006, made non-null by 0012). To clear state we must delete
  // dependents BEFORE `shared_trips`:
  //   1. `chat_threads` — cascades to `chat_messages`.
  //   2. `trip_members` — no cascade, must be explicit.
  //   3. `audit_events` — references `shared_trips.id`.
  //   4. `shared_trips` — cascades to `agent_task_runs`, leaving the
  //      pinned_session_id reference cleared.
  //   0. Everything hanging off `constraint_snapshots`, which `shared_trips`
  //      cascades into. Those references are NO ACTION, not CASCADE, so a row
  //      any other test file left behind blocks the wipe below with a foreign
  //      key violation — and this cleanup is global, not scoped to the trips
  //      this file creates.
  await db.delete(providerOffers);
  await db.delete(providerSearchRuns);
  await db.delete(visaReadinessChecks);
  await db.delete(itineraryPlans);
  await db.delete(chatThreads);
  await db.delete(tripMembers);
  await db.delete(auditEvents);
  await db.delete(sharedTrips);
});

/**
 * Create a shared trip with alice as creator and bob as a required member,
 * then pin alice's CONVERSATION run that carries a `research_intent_draft`
 * with the cross-user-leak data.
 *
 * Insert order:
 *   1. `shared_trips` — FK source for `chat_threads.trip_id` and
 *      `agent_task_runs.trip_id`.
 *   2. `trip_members` — required before `chat_threads` (which references
 *      both the trip and its owner).
 *   3. `chat_threads` — alice's private thread on the trip; required by
 *      `agent_task_runs.thread_id` for a CONVERSATION run.
 *   4. `chat_messages` — alice's user message; required by
 *      `agent_task_runs.user_message_id` for a CONVERSATION run.
 *   5. `agent_task_runs` (CONVERSATION) — the run we will pin. CONVERSATION
 *      is the only one that may carry a non-null `research_intent_draft`
 *      (agent_task_runs_research_intent_draft_scope_chk, migration 0040).
 *   6. Update `shared_trips.pinned_session_id` to point at the run.
 */
async function pinAliceConversationRun(): Promise<string> {
  const tripId = randomUUID();
  const threadId = randomUUID();
  const userMessageId = randomUUID();
  const runId = randomUUID();
  const requestId = randomUUID();

  await db.insert(sharedTrips).values({
    id: tripId,
    name: `pinned-session-test-${tripId}`,
    createdBy: aliceId,
    departureCities: ["San Francisco"],
    destinationCandidates: ["Tokyo"],
  });
  await db.insert(tripMembers).values([
    { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
    { tripId, userId: bobId, role: "MEMBER", isRequired: true },
  ]);
  await db.insert(chatThreads).values({
    id: threadId,
    ownerUserId: aliceId,
    tripId,
    scope: "TRIP",
    title: "Alice scratchpad",
  });
  await db.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    senderUserId: aliceId,
    role: "USER",
    body: "Help me plan this trip",
  });
  await db.insert(agentTaskRuns).values({
    id: runId,
    operation: "CONVERSATION",
    status: "COMPLETED",
    createdByUserId: aliceId,
    threadId,
    tripId,
    userMessageId,
    requestId,
    // `expires_at` is NOT NULL with no default; set to a generous future
    // value so the test row never expires mid-suite.
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    // The cross-user leak: this payload is only meaningful to alice. Bob's
    // pre-Phase-0 GET would have surfaced it; Phase 0 hides it.
    //
    // The pair CHECK (`agent_task_runs_research_intent_pair_chk`,
    // migration 0040) requires `research_intent_draft` and
    // `research_intent_state` to be both NULL or both non-NULL — mirror
    // the live CAS path that writes `"PROPOSED"` alongside the draft.
    researchIntentDraft: { destinationCandidates: ["Kyoto-Private"] },
    researchIntentState: "PROPOSED",
  });
  await db.update(sharedTrips)
    .set({ pinnedSessionId: runId, pinnedAt: new Date(), updatedAt: new Date() })
    .where(eq(sharedTrips.id, tripId));
  return tripId;
}

describe("GET /trips/:tripId — pinnedSession owner-only projection", () => {
  it("alice (pinned-run owner) sees the populated pinnedSession DTO", async () => {
    const tripId = await pinAliceConversationRun();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripId}`,
      headers: authHeaders("alice"),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      trip: { pinnedSession: { agentTaskRunId: string; destinationCandidates: string[] } | null };
    };
    expect(body.trip.pinnedSession).not.toBeNull();
    expect(body.trip.pinnedSession?.agentTaskRunId).toMatch(/^[0-9a-f-]{36}$/);
    // The original draft surface is preserved for the owner.
    expect(body.trip.pinnedSession?.destinationCandidates).toEqual(["Kyoto-Private"]);
  });

  it("bob (other active trip member) gets pinnedSession: null — cross-member leak closed", async () => {
    const tripId = await pinAliceConversationRun();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripId}`,
      headers: authHeaders("bob"),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      trip: { pinnedSession: unknown };
    };
    // Hard close: bob must never see alice's draft.
    expect(body.trip.pinnedSession).toBeNull();
  });

  it("carol (not a member of the trip) gets 403 — membership is the upstream gate", async () => {
    const tripId = await pinAliceConversationRun();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/trips/${tripId}`,
      headers: authHeaders("carol"),
    });

    expect(res.statusCode).toBe(403);
  });

  it("a trip without a pinned run returns pinnedSession: null to every member", async () => {
    const tripId = randomUUID();
    await db.insert(sharedTrips).values({
      id: tripId,
      name: `no-pin-${tripId}`,
      createdBy: aliceId,
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo"],
      // No pinnedSessionId, no pinnedAt.
    });
    await db.insert(tripMembers).values([
      { tripId, userId: aliceId, role: "CREATOR", isRequired: true },
      { tripId, userId: bobId, role: "MEMBER", isRequired: true },
    ]);

    const aliceRes = await app.inject({
      method: "GET", url: `/api/v1/trips/${tripId}`, headers: authHeaders("alice"),
    });
    const bobRes = await app.inject({
      method: "GET", url: `/api/v1/trips/${tripId}`, headers: authHeaders("bob"),
    });
    expect(aliceRes.statusCode).toBe(200);
    expect(bobRes.statusCode).toBe(200);
    expect((aliceRes.json() as { trip: { pinnedSession: unknown } }).trip.pinnedSession).toBeNull();
    expect((bobRes.json() as { trip: { pinnedSession: unknown } }).trip.pinnedSession).toBeNull();
  });
});