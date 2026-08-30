import { afterEach, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

import { runMigrations } from "../../src/db/migrate.js";

const connectionString =
  process.env.TEST_DATABASE_URL
  ?? "postgres://travelagent:travelagent@127.0.0.1:5432/travelagent?options=-csearch_path%3Dtravelagent_test";

describe("migrations 0033/0034/0036 — Personal Trip Orchestrator", () => {
  let client: postgres.Sql;

  beforeEach(async () => {
    client = postgres(connectionString, { max: 1 });
  });

  afterEach(async () => {
    await client.end({ timeout: 5 });
  });

  it("is idempotent — running runMigrations twice is a no-op on the second call", async () => {
    const second = await runMigrations(connectionString);
    expect(second).toEqual([]);
  });

  it("records 0033, 0034, and 0036 in schema_migrations", async () => {
    const rows = await client<{ filename: string }[]>`
      SELECT filename FROM schema_migrations
      WHERE filename IN (
        '0033_personal_research_add_value.sql',
        '0034_personal_research_columns_and_checks.sql',
        '0036_restore_trip_scoped_conversation_task_constraint.sql'
      )
      ORDER BY filename
    `;
    expect(rows.map((r) => r.filename)).toEqual([
      "0033_personal_research_add_value.sql",
      "0034_personal_research_columns_and_checks.sql",
      "0036_restore_trip_scoped_conversation_task_constraint.sql",
    ]);
  });

  it("adds RESEARCH to the agent_task_operation enum", async () => {
    const [row] = await client<{ enum_range: string[] }[]>`
      SELECT enum_range(NULL::agent_task_operation) AS enum_range
    `;
    expect(row?.enum_range).toContain("RESEARCH");
    expect(row?.enum_range).toContain("PLAN");
    expect(row?.enum_range).toContain("REPLAN");
    expect(row?.enum_range).toContain("CONVERSATION");
  });

  it("adds research_mode, requested_capabilities, research_result_id columns to agent_task_runs", async () => {
    const rows = await client<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'agent_task_runs'
        AND column_name IN ('research_mode', 'requested_capabilities', 'research_result_id')
    `;
    const names = rows.map((r) => r.column_name);
    expect(names).toContain("research_mode");
    expect(names).toContain("requested_capabilities");
    expect(names).toContain("research_result_id");
  });

  it("widens the partial unique index to include RESEARCH", async () => {
    const [row] = await client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'agent_task_runs_one_active_planning'
    `;
    expect(row?.indexdef).toBeDefined();
    expect(row?.indexdef).toContain("'PLAN'");
    expect(row?.indexdef).toContain("'REPLAN'");
    expect(row?.indexdef).toContain("'RESEARCH'");
  });

  it("enforces the RESEARCH branch of the operation_refs_check constraint", async () => {
    // RESEARCH requires trip_id + snapshot_id; missing snapshot_id must reject.
    const userId = "00000000-0000-0000-0000-000000000099";
    // Ensure user exists for FK (NOT NULL created_by_user_id).
    await client`
      INSERT INTO users (id, external_id, display_name)
      VALUES (${userId}, 'constraint-test-user', 'Constraint Test')
      ON CONFLICT (id) DO NOTHING
    `;
    const tripId = "00000000-0000-0000-0000-0000000000aa";
    const requestId = "00000000-0000-0000-0000-0000000000bb";

    await expect(
      client`
        INSERT INTO agent_task_runs (operation, created_by_user_id, trip_id, request_id, expires_at)
        VALUES ('RESEARCH', ${userId}, ${tripId}, ${requestId}, NOW() + INTERVAL '5 minutes')
      `,
    ).rejects.toThrow(/agent_task_runs_operation_refs_check|check constraint/i);

    await client`DELETE FROM users WHERE id = ${userId}`;
  });

  it("requires a trip-bound thread for CONVERSATION tasks", async () => {
    const userId = "00000000-0000-0000-0000-000000000098";
    const tripId = "00000000-0000-0000-0000-0000000000a8";
    const threadId = "00000000-0000-0000-0000-0000000000b8";
    const messageId = "00000000-0000-0000-0000-0000000000c8";

    try {
      await client`
        INSERT INTO users (id, external_id, display_name)
        VALUES (${userId}, 'conversation-constraint-user', 'Conversation Constraint Test')
        ON CONFLICT (id) DO NOTHING
      `;
      await client`
        INSERT INTO shared_trips (id, name, created_by, departure_cities, destination_candidates)
        VALUES (${tripId}, 'Conversation constraint trip', ${userId}, '["Singapore"]'::jsonb, '["Jiangxi"]'::jsonb)
      `;
      await client`
        INSERT INTO chat_threads (id, owner_user_id, trip_id, title)
        VALUES (${threadId}, ${userId}, ${tripId}, 'Conversation constraint thread')
      `;
      await client`
        INSERT INTO chat_messages (id, thread_id, sender_user_id, role, body)
        VALUES (${messageId}, ${threadId}, ${userId}, 'USER', 'constraint test')
      `;

      await expect(client`
        INSERT INTO agent_task_runs (
          operation, created_by_user_id, thread_id, trip_id, user_message_id, request_id, expires_at
        ) VALUES (
          'CONVERSATION', ${userId}, ${threadId}, ${tripId}, ${messageId},
          '00000000-0000-0000-0000-0000000000d8', NOW() + INTERVAL '5 minutes'
        )
      `).resolves.toHaveLength(0);

      await expect(client`
        INSERT INTO agent_task_runs (
          operation, created_by_user_id, thread_id, user_message_id, request_id, expires_at
        ) VALUES (
          'CONVERSATION', ${userId}, ${threadId}, ${messageId},
          '00000000-0000-0000-0000-0000000000e8', NOW() + INTERVAL '5 minutes'
        )
      `).rejects.toThrow(/agent_task_runs_operation_refs_check|check constraint/i);
    } finally {
      await client`DELETE FROM chat_threads WHERE id = ${threadId}`;
      await client`DELETE FROM shared_trips WHERE id = ${tripId}`;
      await client`DELETE FROM users WHERE id = ${userId}`;
    }
  });
});
