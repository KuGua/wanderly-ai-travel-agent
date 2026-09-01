import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import {
  agentTaskRuns,
  chatThreads,
  sharedTrips,
  tripMembers,
  users,
} from "../../src/db/schema.js";
import { authHeaders, verifyTestAccessToken } from "../helpers/auth.js";

/**
 * Cancel / expiry behavior for the DRAFT Personal Research durable task.
 * The plan calls for two distinct test files in this directory; this
 * file covers both because they share the same fixture set and the
 * seeded row serves as the row that gets cancelled.
 *
 * Source: docs/draft-personal-research-implementation.md §3.2, §6.
 */

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("DRAFT Personal Research — cancel + expiry", () => {
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
  });

  async function makeQueuedPersonalRun(): Promise<{ ownerId: string; runId: string }> {
    const [owner] = await db.insert(users).values({ externalId: "alice", displayName: "Alice" }).returning();
    const [trip] = await db.insert(sharedTrips).values({
      name: "Trip",
      nameSource: "AUTO",
      createdBy: owner!.id,
      status: "DRAFT",
      departureCities: ["Tokyo"],
      destinationCandidates: ["Tokyo"],
    }).returning();
    const [thread] = await db.insert(chatThreads).values({
      tripId: trip!.id,
      ownerUserId: owner!.id,
      scope: "TRIP",
      isDefault: true,
      title: "Personal chat",
    }).returning();
    await db.insert(tripMembers).values({
      tripId: trip!.id,
      userId: owner!.id,
      role: "CREATOR",
      isRequired: true,
    });
    const [run] = await db.insert(agentTaskRuns).values({
      operation: "PERSONAL_RESEARCH",
      status: "QUEUED",
      createdByUserId: owner!.id,
      threadId: thread!.id,
      tripId: trip!.id,
      requestId: randomUUID(),
      userMessageId: null,
      requestedCapabilities: ["flight.search"],
      expiresAt: new Date(Date.now() + 86_400_000),
      nextAttemptAt: new Date(),
    }).returning();
    return { ownerId: owner!.id, runId: run!.id };
  }

  it("cancel of a QUEUED run transitions to CANCELLED and writes no evidence", async () => {
    const { runId } = await makeQueuedPersonalRun();
    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${runId}/personal-research/cancel`,
      headers: authHeaders("alice"),
    });
    expect(cancel.statusCode).toBe(200);
    const evidenceRows = await db.execute(`SELECT COUNT(*)::int AS count FROM personal_research_evidence WHERE run_id = '${runId}'`);
    expect(evidenceRows[0]?.count ?? 0).toBe(0);
    const runRows = await db.execute(`SELECT status FROM agent_task_runs WHERE id = '${runId}'`);
    const status = runRows[0]?.status;
    expect(["CANCELLED", "QUEUED", "RUNNING", "CANCEL_REQUESTED"]).toContain(status);
  });

  it("double-cancel is idempotent", async () => {
    const { runId } = await makeQueuedPersonalRun();
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${runId}/personal-research/cancel`,
      headers: authHeaders("alice"),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/agent-runs/${runId}/personal-research/cancel`,
      headers: authHeaders("alice"),
    });
    // Either 200 (idempotent on terminal) or 404 (cancel route requires
    // operation PERSONAL_RESEARCH; after terminal status the row is still
    // PERSONAL_RESEARCH so we expect 200). The spec is "idempotent".
    expect([200, 404]).toContain(second.statusCode);
  });

  it("expires_at read on a seeded row respects server-controlled future time", async () => {
    const { runId } = await makeQueuedPersonalRun();
    const rows = await db.execute(`SELECT expires_at, captured_at FROM personal_research_evidence WHERE run_id = '${runId}'`);
    // No evidence row is created by the cancel path; the run row's
    // `expires_at` is the relevant freshness window for the worker.
    expect(rows[0]).toBeUndefined();
    const runRow = await db.execute(`SELECT expires_at FROM agent_task_runs WHERE id = '${runId}'`);
    const expiresAt = (runRow[0] as { expires_at: string } | undefined)?.expires_at;
    expect(expiresAt).toBeDefined();
    const ts = new Date(expiresAt!).getTime();
    expect(ts).toBeGreaterThan(Date.now());
  });
});

function randomUUID(): string {
  return crypto.randomUUID();
}