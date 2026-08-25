import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
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

describe("migration runner", () => {
  beforeEach(async () => {
    const conn = buildConnectionString();
    const client = postgres(conn, { max: 1 });
    try {
      await client`DROP TABLE IF EXISTS schema_migrations`;
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("applies all migrations on first run and is idempotent on the second", async () => {
    const conn = buildConnectionString();
    const first = await runMigrations(conn);
    expect(first.length).toBeGreaterThanOrEqual(4);
    const second = await runMigrations(conn);
    expect(second).toEqual([]);
  });

  it("normalizes legacy browser-authored SYSTEM messages before enforcing final constraints", async () => {
    const conn = buildConnectionString();
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
      const [thread] = await client<{ id: string }[]>`
        INSERT INTO chat_threads (owner_user_id, title)
        VALUES (${userId}, ${title})
        RETURNING id
      `;
      threadId = thread.id;

      await client`ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_role_check`;
      await client`ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_sender_role_check`;
      await client`ALTER TABLE chat_messages ALTER COLUMN sender_user_id SET NOT NULL`;
      await client`DELETE FROM schema_migrations WHERE filename = '0007_chat_conversation.sql'`;

      const legacyCreatedAt = new Date("2026-08-24T12:00:00.000Z");
      await client`
        INSERT INTO chat_messages (
          id, thread_id, sender_user_id, role, body, redacted_summary,
          marked_shared_by_owner, created_at
        ) VALUES
          (${userMessageId}, ${threadId}, ${userId}, 'USER', 'legacy user body', 'safe user summary', true, ${legacyCreatedAt}),
          (${systemMessageId}, ${threadId}, ${userId}, 'SYSTEM', 'legacy system body', 'safe system summary', true, ${legacyCreatedAt})
      `;

      expect(await runMigrations(conn)).toEqual(["0007_chat_conversation.sql"]);

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
      if (threadId) await client`DELETE FROM chat_threads WHERE id = ${threadId}`;
      if (userId) await client`DELETE FROM users WHERE id = ${userId}`;
      await client.end({ timeout: 5 });
    }
  });
});
