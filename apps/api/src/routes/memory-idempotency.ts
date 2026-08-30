import type { FastifyRequest } from "fastify";

import { db } from "../db/database.js";
import { ApiError } from "../middleware/error-handler.js";
import { claimIdempotency, completeIdempotency, loadIdempotencyResult } from "../services/idempotency-service.js";

/**
 * Idempotency for memory write commands (§6).
 *
 * Repeating a memory write is not harmless the way a repeated read is: a second
 * PUT supersedes the fact again, producing another version, another round of
 * stale plans and another audit row — all describing a change the user made
 * once. A retry after a dropped response should return what the first call did.
 *
 * The key is client-supplied and optional. Without one the command runs
 * normally, because forcing a key would break every existing caller; with one
 * the result is replayed.
 */

const KEY_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;

/** Reads and validates the client's `Idempotency-Key`, if it sent one. */
export function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim().length === 0) return null;

  if (!KEY_PATTERN.test(value)) {
    throw new ApiError(
      400, "Bad Request",
      "Idempotency-Key must match /^[A-Za-z0-9:_-]{1,256}$/",
    );
  }
  return value;
}

/**
 * Runs `command` at most once per key.
 *
 * A replay returns the stored payload without re-running, so the caller sees
 * its original result rather than a second version of it. A key claimed by a
 * request still in flight is a conflict rather than a second execution: two
 * concurrent writes of the same command must not both apply.
 */
export async function withMemoryIdempotency<T extends Record<string, unknown>>(
  input: {
    request: FastifyRequest;
    userId: string;
    operation: string;
    entityType: string;
    /** Extracts the id to record alongside the payload. */
    entityId: (result: T) => string;
  },
  command: () => Promise<T>,
): Promise<T> {
  const clientKey = readIdempotencyKey(input.request);
  if (!clientKey) return command();

  const key = `memory:${input.operation}:${input.userId}:${clientKey}`;

  const replay = await loadIdempotencyResult(key);
  if (replay?.resultPayload) return replay.resultPayload as T;

  const claimed = await db.transaction((tx) =>
    claimIdempotency(tx, { key, entityType: input.entityType }));

  if (!claimed) {
    const again = await loadIdempotencyResult(key);
    if (again?.resultPayload) return again.resultPayload as T;
    throw new ApiError(
      409, "Conflict",
      "A request with this Idempotency-Key is still in flight",
    );
  }

  const result = await command();
  await db.transaction((tx) =>
    completeIdempotency(tx, key, input.entityType, input.entityId(result), result));
  return result;
}
