/**
 * Agent Run DTO — researchSetupSession projection regression.
 *
 * Locks the contract that `GET /api/v1/agent-runs/:runId` returns a
 * fully-populated `researchSetupSession` whenever an OPEN setup session
 * exists for the run. The wire schema is `.strict()` and requires
 * `budgetHint` (nullable), so any future serializer regression that
 * drops a required field will surface here as either a 400 from the
 * live route or a schema rejection on the projected object.
 *
 * History: `toRunResponse` previously projected the row without
 * `budgetHint`, returning 400 VALIDATION_REJECTED whenever a
 * CONVERSATION run carried an OPEN setup session. See
 * fix(api): include budgetHint in agent run DTO setup session projection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import postgres from "postgres";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import {
  agentTaskRuns,
  chatMessages,
  chatThreads,
  personalResearchSetupSessions,
  sharedTrips,
  tripMembers,
  users,
} from "../../src/db/schema.js";
import { getAuthorizedAgentRun } from "../../src/tasks/task-repository.js";
import { authHeaders, verifyTestAccessToken } from "../helpers/auth.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("agentRunResponse — researchSetupSession projection", () => {
  let app: Awaited<ReturnType<typeof import("../../src/app.js").buildApp>>;
  let cleanup: postgres.Sql;
  let ownerId: string;

  beforeAll(async () => {
    await runMigrations(connectionString);
    const { buildApp } = await import("../../src/app.js");
    app = await buildApp({ verifyAccessToken: verifyTestAccessToken });
    await app.ready();
    cleanup = postgres(connectionString, { max: 1 });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (cleanup) await cleanup.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await cleanup.unsafe(`
      TRUNCATE TABLE
        audit_events, outbox_events, personal_research_evidence,
        constraint_snapshots, agent_task_runs, idempotency_records,
        chat_messages, chat_threads, provider_search_runs, provider_offers,
        trip_members, trip_search_preferences, trip_stay_search_preferences,
        shared_trips, itinerary_plans, member_confirmations, source_evidence,
        visa_readiness_checks, trip_constraint_proposals, trip_constraint_facts,
        trip_invitations, consent_grants, personal_research_setup_sessions
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;

    const [owner] = await db.insert(users).values({
      externalId: "alice", displayName: "Alice", username: "alice",
    }).returning();
    ownerId = owner!.id;
  });

  /** Build a CONVERSATION run that already carries an OPEN setup session,
   *  matching the post-`getOrOpenSession` state on a NEEDS_SETUP path. */
  async function makeConversationRunWithSetupSession(opts: {
    budgetHint?: { amount: number; currency: string; cadence: "TOTAL" | "PER_NIGHT" | "PER_PERSON" } | null;
    missing?: string[];
  } = {}): Promise<{ runId: string; tripId: string }> {
    const [trip] = await db.insert(sharedTrips).values({
      name: "Trip", nameSource: "AUTO", createdBy: ownerId, status: "DRAFT",
      departureCities: ["Singapore"], destinationCandidates: ["Taipei"],
    }).returning();
    const [thread] = await db.insert(chatThreads).values({
      tripId: trip!.id, ownerUserId: ownerId, scope: "TRIP",
      isDefault: true, title: "Personal chat",
    }).returning();
    await db.insert(tripMembers).values({
      tripId: trip!.id, userId: ownerId, role: "CREATOR", isRequired: true,
    });
    const missing = opts.missing ?? ["DATES_MISSING", "STAY_PREFERENCES_MISSING"];
    const [userMsg] = await db.insert(chatMessages).values({
      threadId: thread!.id,
      senderUserId: ownerId,
      role: "USER",
      body: "请你帮我找一下西门町附近的酒店",
    }).returning();
    const [run] = await db.insert(agentTaskRuns).values({
      operation: "CONVERSATION",
      status: "COMPLETED",
      createdByUserId: ownerId,
      threadId: thread!.id,
      tripId: trip!.id,
      requestId: crypto.randomUUID(),
      userMessageId: userMsg!.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      nextAttemptAt: new Date(),
      researchIntentDraft: {
        schemaVersion: 1,
        kind: "RESEARCH_ONLY",
        requestedCapabilities: ["hotel"],
        classifierVersion: "test",
        readiness: "NEEDS_SETUP",
        blockers: ["DATES_MISSING"],
        warnings: [],
        missing,
      },
      researchIntentState: "PROPOSED",
    }).returning();
    await db.insert(personalResearchSetupSessions).values({
      intentRunId: run!.id,
      tripId: trip!.id,
      ownerUserId: ownerId,
      departureCity: null,
      travelDateStart: null,
      travelDateEnd: null,
      stayPreferences: null,
      flightPreferences: null,
      budgetHint: opts.budgetHint ?? null,
      missing,
      version: 1,
      status: "OPEN",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return { runId: run!.id, tripId: trip!.id };
  }

  it("projects an OPEN setup session with budgetHint=null", async () => {
    const { runId } = await makeConversationRunWithSetupSession();
    const dto = await getAuthorizedAgentRun(runId, ownerId);
    expect(dto.researchSetupSession).not.toBeNull();
    expect(dto.researchSetupSession).toMatchObject({
      intentRunId: runId,
      status: "OPEN",
      missing: ["DATES_MISSING", "STAY_PREFERENCES_MISSING"],
    });
    // The wire-shape field MUST be present (nullable allowed), otherwise
    // the strict response schema rejects with 400 VALIDATION_REJECTED.
    expect("budgetHint" in (dto.researchSetupSession ?? {})).toBe(true);
    expect(dto.researchSetupSession?.budgetHint).toBeNull();
  });

  it("projects an OPEN setup session with a populated budgetHint", async () => {
    const { runId } = await makeConversationRunWithSetupSession({
      budgetHint: { amount: 1200, currency: "USD", cadence: "PER_NIGHT" },
    });
    const dto = await getAuthorizedAgentRun(runId, ownerId);
    expect(dto.researchSetupSession?.budgetHint).toEqual({
      amount: 1200, currency: "USD", cadence: "PER_NIGHT",
    });
  });

  it("returns the live route 200 with the projected session attached", async () => {
    const { runId } = await makeConversationRunWithSetupSession();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/agent-runs/${runId}`,
      headers: authHeaders("alice"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.researchSetupSession).not.toBeNull();
    expect(body.researchSetupSession.status).toBe("OPEN");
    expect("budgetHint" in body.researchSetupSession).toBe(true);
    expect(body.researchSetupSession.budgetHint).toBeNull();
  });

  it("returns researchSetupSession=null when no OPEN session exists", async () => {
    // Run exists but no setup session row — projection must be null,
    // not an object missing budgetHint.
    const { runId } = await makeConversationRunWithSetupSession();
    // Mark the session as CONFIRMED so the projector hides it.
    await db.update(personalResearchSetupSessions)
      .set({ status: "CONFIRMED" })
      .where(eq(personalResearchSetupSessions.intentRunId, runId));
    const dto = await getAuthorizedAgentRun(runId, ownerId);
    expect(dto.researchSetupSession).toBeNull();
  });
});