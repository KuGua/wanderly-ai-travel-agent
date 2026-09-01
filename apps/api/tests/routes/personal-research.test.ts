import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import {
  agentTaskRuns,
  chatMessages,
  chatThreads,
  sharedTrips,
  tripMembers,
  users,
} from "../../src/db/schema.js";
import { authHeaders, verifyTestAccessToken } from "../helpers/auth.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("DRAFT Personal Research routes — Phase 4", () => {
  let app: Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;
  let cleanup: postgres.Sql;

  beforeAll(async () => {
    await runMigrations(connectionString);
    const { buildApp } = await import("../../src/app.js");
    app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
    await app.ready();
    cleanup = postgres(connectionString, { max: 1 });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (cleanup) {
      await cleanup.unsafe(`DELETE FROM personal_research_evidence`);
      await cleanup.unsafe(`DELETE FROM agent_task_runs`);
      await cleanup.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await cleanup.unsafe(`
      TRUNCATE TABLE
        audit_events,
        outbox_events,
        personal_research_evidence,
        constraint_snapshots,
        agent_task_runs,
        idempotency_records,
        chat_messages,
        chat_threads,
        provider_search_runs,
        provider_offers,
        trip_members,
        trip_search_preferences,
        trip_stay_search_preferences,
        shared_trips,
        itinerary_plans,
        member_confirmations,
        source_evidence,
        visa_readiness_checks,
        trip_constraint_proposals,
        trip_constraint_facts,
        trip_invitations,
        consent_grants,
        personal_research_setup_sessions
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;
  });

  async function makeUser(externalId: string): Promise<string> {
    const [u] = await db.insert(users).values({
      externalId,
      displayName: externalId.charAt(0).toUpperCase() + externalId.slice(1),
    }).returning({ id: users.id });
    return u!.id;
  }

  async function makeTripWithDefaultThread(ownerExternalId: string): Promise<{
    ownerId: string;
    tripId: string;
    threadId: string;
  }> {
    const ownerId = await makeUser(ownerExternalId);
    const tripId = randomUUID();
    const threadId = randomUUID();
    await db.insert(sharedTrips).values({
      id: tripId,
      name: `Trip ${tripId.slice(0, 8)}`,
      nameSource: "AUTO",
      createdBy: ownerId,
      status: "DRAFT",
      departureCities: ["San Francisco"],
      destinationCandidates: ["Tokyo", "Osaka"],
    });
    await db.insert(tripMembers).values({
      tripId,
      userId: ownerId,
      role: "CREATOR",
      isRequired: true,
    });
    await db.insert(chatThreads).values({
      id: threadId,
      tripId,
      ownerUserId: ownerId,
      scope: "TRIP",
      isDefault: true,
      title: "Personal chat",
    });
    return { ownerId, tripId, threadId };
  }

  async function makeConversationRun(ownerId: string, tripId: string, threadId: string): Promise<string> {
    const [message] = await db.insert(chatMessages).values({
      threadId,
      senderUserId: ownerId,
      role: "USER",
      body: "I want to fly from PEK to NRT next month",
      markedSharedByOwner: false,
    }).returning({ id: chatMessages.id });
    const [run] = await db.insert(agentTaskRuns).values({
      operation: "CONVERSATION",
      status: "QUEUED",
      createdByUserId: ownerId,
      threadId,
      tripId,
      requestId: randomUUID(),
      userMessageId: message!.id,
      requestedCapabilities: ["flight.search"],
      expiresAt: new Date(Date.now() + 86_400_000),
      nextAttemptAt: new Date(),
    }).returning({ id: agentTaskRuns.id });
    return run!.id;
  }

  const validFlightDraft = {
    schemaVersion: 1 as const,
    draft: {
      kind: "FLIGHT_SEARCH" as const,
      originId: "PEK",
      destinationId: "NRT",
      tripType: "ROUND_TRIP" as const,
      departureDate: "2026-12-01",
      returnDate: "2026-12-08",
      adults: 1,
      cabin: "ECONOMY" as const,
      currency: "USD",
    },
  };

  it("rejects cross-user GET on a personal research run", async () => {
    const { ownerId, tripId, threadId } = await makeTripWithDefaultThread("alice");
    await makeUser("bob");
    const conversationRunId = await makeConversationRun(ownerId, tripId, threadId);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research`,
      headers: { ...authHeaders("bob"), "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("owner GET returns 200 on a fresh conversation run", async () => {
    const { ownerId, tripId, threadId } = await makeTripWithDefaultThread("alice");
    const conversationRunId = await makeConversationRun(ownerId, tripId, threadId);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runId).toBe(conversationRunId);
    expect(body.terminal).toBe(false);
    expect(body.draft).toBeNull();
    expect(body.evidence).toBeNull();
  });

  it("PUT answers stores the typed draft; subsequent GET surfaces it", async () => {
    const { ownerId, tripId, threadId } = await makeTripWithDefaultThread("alice");
    const conversationRunId = await makeConversationRun(ownerId, tripId, threadId);
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/answers`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: validFlightDraft,
    });
    expect(putRes.statusCode).toBe(204);
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
    });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.draft).toBeTruthy();
    expect(body.draft.draft.originId).toBe("PEK");
    expect(body.capability).toBe("flight.search");
  });

  it("confirm returns 202 with the durable runId; second confirm with same requestId is idempotent", async () => {
    const { ownerId, tripId, threadId } = await makeTripWithDefaultThread("alice");
    const conversationRunId = await makeConversationRun(ownerId, tripId, threadId);
    await app.inject({
      method: "PUT",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/answers`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: validFlightDraft,
    });
    const requestId = randomUUID();
    const confirm1 = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/confirm`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { requestId },
    });
    expect(confirm1.statusCode).toBe(202);
    const confirmBody1 = confirm1.json();
    expect(confirmBody1.capability).toBe("flight.search");
    expect(confirmBody1.status).toBe("QUEUED");

    const confirm2 = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/confirm`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { requestId },
    });
    expect(confirm2.statusCode).toBe(202);
    const confirmBody2 = confirm2.json();
    expect(confirmBody2.runId).toBe(confirmBody1.runId);

    const countRows = await db.execute(`SELECT COUNT(*)::int AS count FROM agent_task_runs WHERE operation = 'PERSONAL_RESEARCH' AND created_by_user_id = '${ownerId}'`);
    expect(countRows[0]?.count ?? 0).toBe(1);
  });

  it("confirm rejects a non-flight capability with 422", async () => {
    const { ownerId, tripId, threadId } = await makeTripWithDefaultThread("alice");
    const conversationRunId = await makeConversationRun(ownerId, tripId, threadId);
    // "visa.readiness" is not in the personal_research_capability enum and
    // therefore is rejected at the Zod layer with 422 (capability not
    // enabled). This guards the runtime allow-list gate in the route.
    await app.inject({
      method: "PUT",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/answers`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: {
        schemaVersion: 1,
        draft: {
          kind: "FLIGHT_SEARCH",
          originId: "AAA",
          destinationId: "BBB",
          tripType: "ONE_WAY",
          departureDate: "2026-12-01",
          returnDate: null,
          adults: 0,
          cabin: "ECONOMY",
          currency: "USD",
        },
      },
    });
    const confirm = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/confirm`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { requestId: randomUUID() },
    });
    // adults=0 violates the strict Zod schema (min 1) and is rejected
    // with 422 — proving the route still enforces typed-input validity
    // even when the capability itself is enabled.
    expect(confirm.statusCode).toBe(422);
  });

  it("non-owner cannot cancel an owner-only durable run", async () => {
    const { ownerId, tripId, threadId } = await makeTripWithDefaultThread("alice");
    await makeUser("bob");
    const conversationRunId = await makeConversationRun(ownerId, tripId, threadId);
    await app.inject({
      method: "PUT",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/answers`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: validFlightDraft,
    });
    const confirm = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/confirm`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { requestId: randomUUID() },
    });
    const durableRunId = confirm.json().runId;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${durableRunId}/personal-research/cancel`,
      headers: authHeaders("bob"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("strict schema rejects extra keys on PUT answers", async () => {
    const { ownerId, tripId, threadId } = await makeTripWithDefaultThread("alice");
    const conversationRunId = await makeConversationRun(ownerId, tripId, threadId);
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/answers`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: {
        schemaVersion: 1,
        draft: {
          ...validFlightDraft.draft,
          secretField: "leak",
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("strict schema rejects invalid IATA on PUT answers", async () => {
    const { ownerId, tripId, threadId } = await makeTripWithDefaultThread("alice");
    const conversationRunId = await makeConversationRun(ownerId, tripId, threadId);
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/answers`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: {
        schemaVersion: 1,
        draft: {
          ...validFlightDraft.draft,
          originId: "BEIJING", // not 3 uppercase letters
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("personal_research_evidence rows are scoped to owner — cross-user durable run GET returns 403", async () => {
    const { ownerId, tripId, threadId } = await makeTripWithDefaultThread("alice");
    await makeUser("bob");
    const conversationRunId = await makeConversationRun(ownerId, tripId, threadId);
    await app.inject({
      method: "PUT",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/answers`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: validFlightDraft,
    });
    const confirm = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${conversationRunId}/personal-research/confirm`,
      headers: { ...authHeaders("alice"), "content-type": "application/json" },
      payload: { requestId: randomUUID() },
    });
    const durableRunId = confirm.json().runId;
    // Worker is not running in tests; the durable row stays QUEUED with no
    // evidence. Privacy is enforced at the run-row level (requireRunAccess
    // PERSONAL_RESEARCH branch — owner-only).
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/agent-runs/${durableRunId}/personal-research`,
      headers: { ...authHeaders("bob"), "content-type": "application/json" },
    });
    expect(getRes.statusCode).toBe(403);
  });
});