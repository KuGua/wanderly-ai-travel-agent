import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrate.js";

function buildConnectionString(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.DB_USER ?? "travelagent";
  const password = process.env.DB_PASSWORD ?? "travelagent";
  const host = process.env.DB_HOST ?? "127.0.0.1";
  const port = process.env.DB_PORT ?? "5432";
  const database = process.env.DB_NAME ?? "travelagent";
  return `postgres://${user}:${password}@${host}:${port}/${database}`;
}

/**
 * Each test gets its own empty schema to migrate into.
 *
 * This used to drop `schema_migrations` on the shared test schema and replay
 * every migration over it, which had two costs. The replay ran against a
 * schema already full of other files' rows, so any migration that adds a CHECK
 * constraint failed validating that leftover data — and because it also
 * re-ran the early migrations, `0023`'s `DROP TYPE ... CASCADE` silently took
 * `research_route_selections.mode` and two foreign keys with it, leaving the
 * shared schema permanently short of a column no later migration would
 * restore. Tests downstream then grew workarounds for the wreckage.
 *
 * A scratch schema gives the replay what it actually wants — a clean database
 * — and keeps it from reaching anything else.
 */
async function withScratchSchema<T>(run: (conn: string) => Promise<T>): Promise<T> {
  const schema = `migrate_${randomUUID().replace(/-/g, "")}_test`;
  const base = new URL(buildConnectionString());
  base.searchParams.delete("options");
  const admin = postgres(base.toString(), { max: 1 });
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(base);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    return await run(scoped.toString());
  } finally {
    try {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
}

describe("migration runner", () => {
  it("applies all migrations on first run and is idempotent on the second", async () => {
    await withScratchSchema(async conn => {
      const first = await runMigrations(conn);
      expect(first.length).toBeGreaterThanOrEqual(4);
      const second = await runMigrations(conn);
      expect(second).toEqual([]);
    });
  });

  it("normalizes legacy browser-authored SYSTEM messages before enforcing final constraints", async () => {
    await withScratchSchema(async conn => {
    await runMigrations(conn);
    const client = postgres(conn, { max: 1 });
    const externalId = `migration-user-${randomUUID()}`;
    const title = `migration-thread-${randomUUID()}`;
    const userMessageId = randomUUID();
    const systemMessageId = randomUUID();
    let userId: string | undefined;
    let threadId: string | undefined;

    try {
      const [user] = await client<{ id: string }[]>`
        INSERT INTO users (external_id, display_name)
        VALUES (${externalId}, 'Migration Test User')
        RETURNING id
      `;
      userId = user.id;
      // Per docs/trip-scoped-private-threads-implementation.md §1.1 every
      // chat thread must belong to a Trip.  Provision one so the legacy
      // role-normalization migration can run its scenario.
      const tripId = randomUUID();
      await client`
        INSERT INTO shared_trips (id, name, created_by, departure_cities, destination_candidates)
        VALUES (${tripId}, 'Migration Trip', ${userId}, ${["San Francisco"]}, ${["Tokyo"]})
      `;
      await client`
        INSERT INTO trip_members (trip_id, user_id, role, is_required)
        VALUES (${tripId}, ${userId}, 'CREATOR', true)
      `;
      const [thread] = await client<{ id: string }[]>`
        INSERT INTO chat_threads (owner_user_id, trip_id, scope, is_default, title)
        VALUES (${userId}, ${tripId}, 'TRIP', false, ${title})
        RETURNING id
      `;
      threadId = thread.id;

      await client`ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_role_check`;
      await client`ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_sender_role_check`;
      await client`ALTER TABLE chat_messages ALTER COLUMN sender_user_id SET NOT NULL`;
      await client`DELETE FROM schema_migrations WHERE filename = '0008_chat_conversation.sql'`;

      const legacyCreatedAt = new Date("2026-08-24T12:00:00.000Z");
      await client`
        INSERT INTO chat_messages (
          id, thread_id, sender_user_id, role, body, redacted_summary,
          marked_shared_by_owner, created_at
        ) VALUES
          (${userMessageId}, ${threadId}, ${userId}, 'USER', 'legacy user body', 'safe user summary', true, ${legacyCreatedAt}),
          (${systemMessageId}, ${threadId}, ${userId}, 'SYSTEM', 'legacy system body', 'safe system summary', true, ${legacyCreatedAt})
      `;

      expect(await runMigrations(conn)).toEqual(["0008_chat_conversation.sql"]);

      const rows = await client<{
        id: string;
        senderUserId: string | null;
        role: string;
        body: string;
        redactedSummary: string | null;
        markedSharedByOwner: boolean;
        createdAt: Date;
      }[]>`
        SELECT
          id,
          sender_user_id AS "senderUserId",
          role,
          body,
          redacted_summary AS "redactedSummary",
          marked_shared_by_owner AS "markedSharedByOwner",
          created_at AS "createdAt"
        FROM chat_messages
        WHERE id IN (${userMessageId}, ${systemMessageId})
        ORDER BY id
      `;
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: userMessageId,
          senderUserId: userId,
          role: "USER",
          body: "legacy user body",
          redactedSummary: "safe user summary",
          markedSharedByOwner: true,
          createdAt: legacyCreatedAt,
        }),
        expect.objectContaining({
          id: systemMessageId,
          senderUserId: userId,
          role: "USER",
          body: "legacy system body",
          redactedSummary: "safe system summary",
          markedSharedByOwner: true,
          createdAt: legacyCreatedAt,
        }),
      ]));

      await expect(client`
        INSERT INTO chat_messages (thread_id, sender_user_id, role, body)
        VALUES (${threadId}, ${userId}, 'ASSISTANT', 'forged assistant')
      `).rejects.toThrow();
      await expect(client`
        INSERT INTO chat_messages (thread_id, sender_user_id, role, body)
        VALUES (${threadId}, NULL, 'USER', 'ownerless user')
      `).rejects.toThrow();
      await expect(client`
        INSERT INTO chat_messages (thread_id, sender_user_id, role, body)
        VALUES (${threadId}, NULL, 'ASSISTANT', 'valid assistant')
      `).resolves.toBeDefined();

      expect(await runMigrations(conn)).toEqual([]);
    } finally {
      // The scratch schema is dropped either way; this only releases the
      // connection so the pool does not carry it for the rest of the run.
      await client.end({ timeout: 5 });
    }
    });
  });
});
