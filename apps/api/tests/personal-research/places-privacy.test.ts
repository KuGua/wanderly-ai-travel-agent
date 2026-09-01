import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

import { runMigrations } from "../../src/db/migrate.js";
import { db } from "../../src/db/database.js";
import { agentTaskRuns, chatMessages, chatThreads, sharedTrips, tripMembers, users } from "../../src/db/schema.js";
import { executePersonalPlacesSearch } from "../../src/services/personal-research-executors/places.js";
import { verifyTestAccessToken } from "../helpers/auth.js";

/**
 * Privacy boundary — the Personal places executor must NEVER write to
 * `trip_places` even on the SUCCESS path. Only the Shared
 * `route-endpoints` POST and the Shared PLACES adopt flow may insert
 * `trip_places` rows; Personal results are strictly owner-advisory until
 * the owner manually adopts them via the Shared adopt endpoint.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5 stage 3.
 */
const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("Personal places privacy: never writes trip_places", () => {
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
        trip_places, trip_members, trip_search_preferences,
        trip_stay_search_preferences, shared_trips, itinerary_plans,
        member_confirmations, source_evidence, visa_readiness_checks,
        trip_constraint_proposals, trip_constraint_facts, trip_invitations,
        consent_grants, personal_research_setup_sessions
      RESTART IDENTITY CASCADE
    `);
    await cleanup`DELETE FROM users`;
  });

  it("does not insert any trip_places row when the executor succeeds", async () => {
    // Stub provider factory via env-less local mock — the executor uses
    // `createOrsPlace` which returns an `UnavailablePlaceProvider` unless
    // ORS_API_KEY is set. We exercise the SUCCESS branch directly by
    // calling the executor with a mock provider injection via vi.spyOn.
    const vi = await import("vitest");
    const factoryModule = await import("../../src/providers/live-provider-factory.js");
    const mockProvider = {
      searchPlaces: vi.vi.fn().mockResolvedValue({
        outcome: "LIVE" as const,
        data: [
          {
            candidateId: "c-1",
            displayName: "Adoptable Place",
            kind: "ATTRACTION" as const,
            countryCode: "JP",
            cityName: "Tokyo",
            longitude: 139.79,
            latitude: 35.71,
            confidence: 0.9,
            needsUserConfirmation: false,
            source: "ors",
            capturedAt: new Date().toISOString(),
          },
        ],
        source: "ors",
        capturedAt: new Date().toISOString(),
      }),
    };
    const spy = vi.vi.spyOn(factoryModule, "createOrsPlace").mockReturnValue(mockProvider as never);

    const [owner] = await db.insert(users).values({ externalId: "alice", displayName: "Alice" }).returning();
    const [tripRow] = await db.insert(sharedTrips).values({
      name: "Trip Test",
      nameSource: "AUTO",
      createdBy: owner!.id,
      status: "DRAFT",
      departureCities: ["Tokyo"],
      destinationCandidates: ["Tokyo"],
    }).returning();
    const [thread] = await db.insert(chatThreads).values({
      tripId: tripRow!.id,
      ownerUserId: owner!.id,
      scope: "TRIP",
      isDefault: true,
      title: "Personal chat",
    }).returning();
    await db.insert(tripMembers).values({
      tripId: tripRow!.id,
      userId: owner!.id,
      role: "CREATOR",
      isRequired: true,
    });
    const [message] = await db.insert(chatMessages).values({
      threadId: thread!.id,
      senderUserId: owner!.id,
      role: "USER",
      body: "find attractions in Tokyo",
      markedSharedByOwner: false,
    }).returning();
    void message;
    const [run] = await db.insert(agentTaskRuns).values({
      operation: "PERSONAL_RESEARCH",
      status: "QUEUED",
      createdByUserId: owner!.id,
      threadId: thread!.id,
      tripId: tripRow!.id,
      requestId: "11111111-1111-4111-8111-111111111111",
      userMessageId: null,
      requestedCapabilities: ["places.search"],
      expiresAt: new Date(Date.now() + 86_400_000),
      nextAttemptAt: new Date(),
    }).returning();

    void chatMessages;
    const tripPlaceCountRow = await db.execute(`SELECT COUNT(*)::int AS count FROM trip_places WHERE trip_id = '${tripRow!.id}'`);
    const beforeTripPlaceCount = tripPlaceCountRow[0]?.count ?? 0;

    const result = await executePersonalPlacesSearch({
      run: run!,
      draft: {
        kind: "PLACES_SEARCH",
        latitude: 35.68,
        longitude: 139.69,
        radiusMeters: 5000,
        category: "ATTRACTION",
        limit: 10,
      },
      signal: new AbortController().signal,
    });

    expect(result.outcome).toBe("AVAILABLE");

    const afterTripPlaceCountRow = await db.execute(`SELECT COUNT(*)::int AS count FROM trip_places WHERE trip_id = '${tripRow!.id}'`);
    const afterTripPlaceCount = afterTripPlaceCountRow[0]?.count ?? 0;
    expect(afterTripPlaceCount).toBe(beforeTripPlaceCount);

    // No evidence was persisted either — the executor does NOT touch the
    // DB; the handler is responsible for persistence.
    const evidenceRows = await db.execute(`SELECT COUNT(*)::int AS count FROM personal_research_evidence WHERE run_id = '${run!.id}'`);
    expect(evidenceRows[0]?.count ?? 0).toBe(0);

    spy.mockRestore();
  });
});