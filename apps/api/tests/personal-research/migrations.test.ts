import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Migration test for `0047_personal_research_add_operation.sql`,
 * `0048_personal_research_widen_refs.sql`, and
 * `0049_personal_research_evidence.sql` — together the additive migration
 * that creates the new operation enum value, the widened
 * `agent_task_runs_operation_refs_check`, the partial unique idempotency
 * index, the `personal_research_capability` and `personal_research_outcome`
 * enums, and the `personal_research_evidence` table.
 *
 * Each `it` truncates dependent tables in `beforeAll` so its inserts are
 * the only rows in scope. The runner re-applies all migrations in
 * `beforeAll`; `afterAll` is a no-op because the runner leaves the schema
 * in its final shape.
 *
 * Source: docs/draft-personal-research-implementation.md §3.2, §5.
 */

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

async function truncateAll(c: postgres.Sql): Promise<void> {
  await c.unsafe(`
    TRUNCATE TABLE
      audit_events, outbox_events, personal_research_evidence,
      constraint_snapshots, agent_task_runs, idempotency_records,
      chat_messages, chat_threads, provider_search_runs, provider_offers,
      trip_places, trip_members, trip_search_preferences,
      trip_stay_search_preferences, shared_trips, itinerary_plans,
      member_confirmations, source_evidence, visa_readiness_checks,
      trip_constraint_proposals, trip_constraint_facts, trip_invitations
    RESTART IDENTITY CASCADE
  `);
  await c`DELETE FROM users`;
}

describe("0047 + 0048 + 0049 — DRAFT Personal Research schema", () => {
  let cleanup: postgres.Sql;

  beforeAll(async () => {
    const { runMigrations } = await import("../../src/db/migrate.js");
    await runMigrations(connectionString);
    cleanup = postgres(connectionString, { max: 1 });
    await truncateAll(cleanup);
  });

  afterAll(async () => {
    if (cleanup) {
      await truncateAll(cleanup);
      await cleanup.end({ timeout: 5 });
    }
  });

  it("agent_task_operation enum contains PERSONAL_RESEARCH", async () => {
    const rows = await cleanup<{ enum_range: string }[]>`
      SELECT enum_range(NULL::agent_task_operation)::text
    `;
    expect(rows[0]?.enum_range).toContain("PERSONAL_RESEARCH");
  });

  it("agent_task_runs_operation_refs_check admits PERSONAL_RESEARCH with thread_id non-null and snapshot_id null", async () => {
    const tripId = "00000000-0000-0000-0000-000000000001";
    const threadId = "00000000-0000-0000-0000-000000000002";
    const ownerId = "00000000-0000-0000-0000-000000000003";
    const runId = "00000000-0000-0000-0000-000000000004";
    await cleanup`
      INSERT INTO users (id, external_id, display_name) VALUES (${ownerId}, 'alice', 'Alice')
    `;
    await cleanup`
      INSERT INTO shared_trips (id, name, name_source, title_locale, created_by, status, departure_cities, destination_candidates)
      VALUES (${tripId}, 'Trip', 'AUTO', 'en', ${ownerId}, 'DRAFT', '["Tokyo"]'::jsonb, '["Tokyo"]'::jsonb)
    `;
    await cleanup`
      INSERT INTO trip_members (trip_id, user_id, role, is_required)
      VALUES (${tripId}, ${ownerId}, 'CREATOR', true)
    `;
    await cleanup`
      INSERT INTO chat_threads (id, trip_id, owner_user_id, scope, is_default, title)
      VALUES (${threadId}, ${tripId}, ${ownerId}, 'TRIP', true, 'Personal chat')
    `;
    await cleanup`
      INSERT INTO agent_task_runs (id, operation, status, created_by_user_id, thread_id, trip_id, snapshot_id, request_id, user_message_id, expires_at, next_attempt_at)
      VALUES (${runId}, 'PERSONAL_RESEARCH', 'QUEUED', ${ownerId}, ${threadId}, ${tripId}, NULL, ${runId}::text::uuid, NULL, now() + interval '1 day', now())
    `;
    const rows = await cleanup<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM agent_task_runs WHERE id = ${runId}::text::uuid
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it("agent_task_runs_operation_refs_check rejects PERSONAL_RESEARCH with snapshot_id non-null", async () => {
    const tripId = "00000000-0000-0000-0000-000000000010";
    const threadId = "00000000-0000-0000-0000-000000000011";
    const ownerId = "00000000-0000-0000-0000-000000000012";
    const snapshotId = "00000000-0000-0000-0000-000000000013";
    const runId = "00000000-0000-0000-0000-000000000014";
    await cleanup`
      INSERT INTO users (id, external_id, display_name) VALUES (${ownerId}, 'bob', 'Bob')
    `;
    await cleanup`
      INSERT INTO shared_trips (id, name, name_source, title_locale, created_by, status, departure_cities, destination_candidates)
      VALUES (${tripId}, 'Trip2', 'AUTO', 'en', ${ownerId}, 'DRAFT', '["Tokyo"]'::jsonb, '["Tokyo"]'::jsonb)
    `;
    await cleanup`
      INSERT INTO trip_members (trip_id, user_id, role, is_required)
      VALUES (${tripId}, ${ownerId}, 'CREATOR', true)
    `;
    await cleanup`
      INSERT INTO chat_threads (id, trip_id, owner_user_id, scope, is_default, title)
      VALUES (${threadId}, ${tripId}, ${ownerId}, 'TRIP', true, 'Personal chat 2')
    `;
    await cleanup`
      INSERT INTO constraint_snapshots (id, trip_id, version, authorized_data, departure_cities, destination_candidates)
      VALUES (${snapshotId}, ${tripId}, 1, '{}'::jsonb, '["Tokyo"]'::jsonb, '["Tokyo"]'::jsonb)
    `;
    await expect(cleanup`
      INSERT INTO agent_task_runs (id, operation, status, created_by_user_id, thread_id, trip_id, snapshot_id, request_id, user_message_id, expires_at, next_attempt_at)
      VALUES (${runId}, 'PERSONAL_RESEARCH', 'QUEUED', ${ownerId}, ${threadId}, ${tripId}, ${snapshotId}, ${runId}::text::uuid, NULL, now() + interval '1 day', now())
    `).rejects.toThrow(/violates check constraint/);
  });

  it("agent_task_runs_personal_research_owner_request_unique enforces idempotency per owner+requestId", async () => {
    const tripId = "00000000-0000-0000-0000-000000000020";
    const threadId = "00000000-0000-0000-0000-000000000021";
    const ownerId = "00000000-0000-0000-0000-000000000022";
    const requestId = "00000000-0000-0000-0000-000000000023";
    const runIdA = "00000000-0000-0000-0000-000000000024";
    const runIdB = "00000000-0000-0000-0000-000000000025";
    await cleanup`
      INSERT INTO users (id, external_id, display_name) VALUES (${ownerId}, 'carol', 'Carol')
    `;
    await cleanup`
      INSERT INTO shared_trips (id, name, name_source, title_locale, created_by, status, departure_cities, destination_candidates)
      VALUES (${tripId}, 'Trip3', 'AUTO', 'en', ${ownerId}, 'DRAFT', '["Tokyo"]'::jsonb, '["Tokyo"]'::jsonb)
    `;
    await cleanup`
      INSERT INTO trip_members (trip_id, user_id, role, is_required)
      VALUES (${tripId}, ${ownerId}, 'CREATOR', true)
    `;
    await cleanup`
      INSERT INTO chat_threads (id, trip_id, owner_user_id, scope, is_default, title)
      VALUES (${threadId}, ${tripId}, ${ownerId}, 'TRIP', true, 'Personal chat 3')
    `;
    await cleanup`
      INSERT INTO agent_task_runs (id, operation, status, created_by_user_id, thread_id, trip_id, snapshot_id, request_id, user_message_id, expires_at, next_attempt_at)
      VALUES (${runIdA}, 'PERSONAL_RESEARCH', 'QUEUED', ${ownerId}, ${threadId}, ${tripId}, NULL, ${requestId}::text::uuid, NULL, now() + interval '1 day', now())
    `;
    await expect(cleanup`
      INSERT INTO agent_task_runs (id, operation, status, created_by_user_id, thread_id, trip_id, snapshot_id, request_id, user_message_id, expires_at, next_attempt_at)
      VALUES (${runIdB}, 'PERSONAL_RESEARCH', 'QUEUED', ${ownerId}, ${threadId}, ${tripId}, NULL, ${requestId}::text::uuid, NULL, now() + interval '1 day', now())
    `).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it("personal_research_capability enum does NOT contain visa.*", async () => {
    const rows = await cleanup<{ enum_range: string }[]>`
      SELECT enum_range(NULL::personal_research_capability)::text
    `;
    const text = rows[0]?.enum_range ?? "";
    expect(text).not.toContain("visa");
  });

  it("personal_research_evidence table exists with the expected columns and indexes", async () => {
    const cols = await cleanup<{ column_name: string }[]>`
      SELECT DISTINCT column_name FROM information_schema.columns
      WHERE table_name = 'personal_research_evidence'
      ORDER BY column_name
    `;
    const colNames = cols.map((c) => c.column_name);
    // The executor never reads these directly; the Drizzle inference is the
    // source of truth. The list here is the bounded projection we want to
    // survive future additive columns.
    for (const required of [
      "id", "run_id", "trip_id", "thread_id", "owner_user_id",
      "capability", "outcome", "provider_name", "source",
      "captured_at", "expires_at", "result_json", "created_at",
    ]) {
      expect(colNames).toContain(required);
    }
    const indexes = await cleanup<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'personal_research_evidence'
    `;
    const idxNames = indexes.map((i) => i.indexname);
    expect(idxNames).toContain("personal_research_evidence_pkey");
    expect(idxNames).toContain("personal_research_evidence_run_search_unique");
    // 0056 dropped both of 0049's unique indexes. `(run_id, owner_user_id)`
    // meant to say a run has one owner and ended up saying a run has one row;
    // `(run_id, capability)` meant retry idempotency and stopped a turn from
    // asking the same capability two different questions.
    expect(idxNames).not.toContain("personal_research_evidence_run_owner_unique");
  });

  it("personal_research_evidence_run_search_unique rejects the same search twice on one run", async () => {
    const tripId = "00000000-0000-0000-0000-000000000030";
    const threadId = "00000000-0000-0000-0000-000000000031";
    const ownerId = "00000000-0000-0000-0000-000000000032";
    const runId = "00000000-0000-0000-0000-000000000033";
    await cleanup`
      INSERT INTO users (id, external_id, display_name) VALUES (${ownerId}, 'dave', 'Dave')
    `;
    await cleanup`
      INSERT INTO shared_trips (id, name, name_source, title_locale, created_by, status, departure_cities, destination_candidates)
      VALUES (${tripId}, 'Trip4', 'AUTO', 'en', ${ownerId}, 'DRAFT', '["Tokyo"]'::jsonb, '["Tokyo"]'::jsonb)
    `;
    await cleanup`
      INSERT INTO trip_members (trip_id, user_id, role, is_required)
      VALUES (${tripId}, ${ownerId}, 'CREATOR', true)
    `;
    await cleanup`
      INSERT INTO chat_threads (id, trip_id, owner_user_id, scope, is_default, title)
      VALUES (${threadId}, ${tripId}, ${ownerId}, 'TRIP', true, 'Personal chat 4')
    `;
    await cleanup`
      INSERT INTO agent_task_runs (id, operation, status, created_by_user_id, thread_id, trip_id, snapshot_id, request_id, user_message_id, expires_at, next_attempt_at)
      VALUES (${runId}, 'PERSONAL_RESEARCH', 'QUEUED', ${ownerId}, ${threadId}, ${tripId}, NULL, ${runId}::text::uuid, NULL, now() + interval '1 day', now())
    `;
    await cleanup`
      INSERT INTO personal_research_evidence (run_id, trip_id, thread_id, owner_user_id, capability, outcome, provider_name, source, result_json)
      VALUES (${runId}::text::uuid, ${tripId}::text::uuid, ${threadId}::text::uuid, ${ownerId}::text::uuid, 'flight.search', 'AVAILABLE', 'amadeus', 'amadeus', '{}'::jsonb)
    `;
    await expect(cleanup`
      INSERT INTO personal_research_evidence (run_id, trip_id, thread_id, owner_user_id, capability, outcome, provider_name, source, result_json)
      VALUES (${runId}::text::uuid, ${tripId}::text::uuid, ${threadId}::text::uuid, ${ownerId}::text::uuid, 'flight.search', 'AVAILABLE', 'amadeus', 'amadeus', '{}'::jsonb)
    `).rejects.toThrow(/duplicate key value violates unique constraint/);

    // …but a different search on the same run is a different row. A turn
    // where the traveller asks "附近有什么餐厅吗？有什么好玩的景点吗" is two
    // `places.search` calls, and the second used to fail to insert, be
    // reported to the model as a supplier failure, and come back to the
    // traveller as "供应商目前无法返回实时列表".
    await cleanup`
      INSERT INTO personal_research_evidence (run_id, trip_id, thread_id, owner_user_id, capability, outcome, provider_name, source, result_json, request_fingerprint)
      VALUES (${runId}::text::uuid, ${tripId}::text::uuid, ${threadId}::text::uuid, ${ownerId}::text::uuid, 'flight.search', 'AVAILABLE', 'amadeus', 'amadeus', '{}'::jsonb, 'other-query')
    `;
    const rows = await cleanup<{ count: string }[]>`
      SELECT count(*)::text AS count FROM personal_research_evidence WHERE run_id = ${runId}::text::uuid
    `;
    expect(rows[0].count).toBe("2");
  });
});