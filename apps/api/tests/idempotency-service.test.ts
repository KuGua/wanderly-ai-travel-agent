import { describe, expect, it } from "vitest";
import { db } from "../src/db/database.js";
import { idempotencyRecords } from "../src/db/schema.js";
import { claimIdempotency, checkIdempotency } from "../src/services/idempotency-service.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

async function cleanup(key: string) {
  await db.delete(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key));
}

describe("idempotency-service.claimIdempotency", () => {
  it("returns the inserted row on first claim and null on the second concurrent claim", async () => {
    const key = `test:${randomUUID()}`;
    await cleanup(key);

    await db.transaction(async (tx) => {
      const first = await claimIdempotency(tx, { key, entityType: "test" });
      expect(first).not.toBeNull();
      const second = await claimIdempotency(tx, { key, entityType: "test" });
      expect(second).toBeNull();
    });

    await cleanup(key);
  });

  it("does not allow two distinct callers to share a key under concurrency", async () => {
    const key = `test:${randomUUID()}`;
    await cleanup(key);

    // Simulate two concurrent transactions racing for the same key.
    const results = await Promise.all([
      db.transaction(async (tx) => claimIdempotency(tx, { key, entityType: "test" })),
      db.transaction(async (tx) => claimIdempotency(tx, { key, entityType: "test" })),
    ]);
    const winners = results.filter(r => r !== null);
    expect(winners.length).toBe(1);

    await cleanup(key);
  });

  it("checkIdempotency sees the claim once the surrounding transaction commits", async () => {
    const key = `test:${randomUUID()}`;
    await cleanup(key);

    await db.transaction(async (tx) => {
      await claimIdempotency(tx, { key, entityType: "test" });
    });

    const result = await checkIdempotency(key);
    expect(result.exists).toBe(true);

    await cleanup(key);
  });
});
