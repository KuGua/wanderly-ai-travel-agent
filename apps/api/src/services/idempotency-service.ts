import { eq } from "drizzle-orm";
import { db } from "../db/database.js";
import { idempotencyRecords } from "../db/schema.js";

// Drizzle transaction callback parameter type. Aliased for readability.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Read-only idempotency probe. Prefer `claimIdempotency` for new code
 * because the check-then-write pattern is racy under concurrent calls.
 */
export async function checkIdempotency(
  key: string,
  tx?: Tx,
): Promise<{ exists: boolean; result?: Record<string, unknown> }> {
  const target = tx ?? db;
  const existing = await target.select().from(idempotencyRecords)
    .where(eq(idempotencyRecords.idempotencyKey, key))
    .limit(1);
  if (existing.length > 0) {
    return {
      exists: true,
      result: (existing[0].resultPayload as Record<string, unknown>) ?? undefined,
    };
  }
  return { exists: false };
}

/**
 * Late-write idempotency recording. Prefer `claimIdempotency` for new code
 * because the check-then-write pattern is racy under concurrent calls.
 */
export async function recordIdempotency(params: {
  key: string;
  entityType: string;
  entityId?: string;
  resultPayload?: Record<string, unknown>;
  ttlSeconds?: number;
  tx?: Tx;
}): Promise<void> {
  const expiresAt = params.ttlSeconds
    ? new Date(Date.now() + params.ttlSeconds * 1000)
    : new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000);

  const target = params.tx ?? db;
  await target.insert(idempotencyRecords).values({
    idempotencyKey: params.key,
    entityType: params.entityType,
    entityId: params.entityId,
    resultPayload: params.resultPayload,
    expiresAt,
  });
}

/**
 * Atomically claim an idempotency key inside a transaction. Returns the
 * inserted row on first claim; returns `null` if another worker has
 * already claimed the same key. Race-safe by virtue of the underlying
 * `idempotency_records.idempotency_key` UNIQUE constraint.
 *
 * Must be invoked inside a `db.transaction` so the claim and the
 * downstream side effects share an atomicity boundary.
 */
export async function claimIdempotency(
  tx: Tx,
  params: { key: string; entityType: string; ttlSeconds?: number },
): Promise<{ key: string; entityType: string } | null> {
  const expiresAt = params.ttlSeconds
    ? new Date(Date.now() + params.ttlSeconds * 1000)
    : new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000);

  const inserted = await tx.insert(idempotencyRecords)
    .values({
      idempotencyKey: params.key,
      entityType: params.entityType,
      expiresAt,
    })
    .onConflictDoNothing({ target: idempotencyRecords.idempotencyKey })
    .returning();

  if (inserted.length === 0) {
    return null;
  }
  return { key: inserted[0].idempotencyKey, entityType: inserted[0].entityType };
}

/**
 * Fill the result payload on a previously-claimed idempotency row. Must be
 * invoked inside the same transaction as `claimIdempotency` so a caller
 * replaying the same key sees a populated `resultPayload`. The `entityId`
 * is the canonical resource id (e.g. the new Trip) so replay reads can
 * resolve without consulting business tables.
 */
export async function completeIdempotency(
  tx: Tx,
  key: string,
  entityType: string,
  entityId: string,
  resultPayload: Record<string, unknown>,
): Promise<void> {
  await tx.update(idempotencyRecords)
    .set({ entityId, resultPayload, entityType })
    .where(eq(idempotencyRecords.idempotencyKey, key));
}

/**
 * Load the cached result for a previously-completed idempotency key. Used
 * by replay paths to return the exact same response body without writing
 * new business state. Returns `null` when the key is unknown or its
 * payload is not yet populated.
 */
export async function loadIdempotencyResult(
  key: string,
): Promise<{ entityId: string; resultPayload: Record<string, unknown> } | null> {
  const [row] = await db.select({
    entityId: idempotencyRecords.entityId,
    resultPayload: idempotencyRecords.resultPayload,
  })
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.idempotencyKey, key))
    .limit(1);
  if (!row?.entityId || !row.resultPayload) return null;
  return {
    entityId: row.entityId,
    resultPayload: row.resultPayload as Record<string, unknown>,
  };
}
