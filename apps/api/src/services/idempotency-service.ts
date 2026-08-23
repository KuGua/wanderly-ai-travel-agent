import { db } from "../db/database.js";
import { idempotencyRecords } from "../db/schema.js";
import { eq } from "drizzle-orm";

export async function checkIdempotency(key: string): Promise<{ exists: boolean; result?: Record<string, unknown> }> {
  const existing = await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.idempotencyKey, key)).limit(1);
  if (existing.length > 0) {
    return { exists: true, result: (existing[0].resultPayload as Record<string, unknown>) ?? undefined };
  }
  return { exists: false };
}

export async function recordIdempotency(params: {
  key: string;
  entityType: string;
  entityId?: string;
  resultPayload?: Record<string, unknown>;
  ttlSeconds?: number;
}): Promise<void> {
  const expiresAt = params.ttlSeconds
    ? new Date(Date.now() + params.ttlSeconds * 1000)
    : new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h default

  await db.insert(idempotencyRecords).values({
    idempotencyKey: params.key,
    entityType: params.entityType,
    entityId: params.entityId,
    resultPayload: params.resultPayload,
    expiresAt,
  });
}
