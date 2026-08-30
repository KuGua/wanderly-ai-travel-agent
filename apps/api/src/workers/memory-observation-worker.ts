import { eq } from "drizzle-orm";

import { db, rawDb } from "../db/database.js";
import { userProfiles } from "../db/schema.js";
import { observeBehavior } from "../services/memory-proposal-service.js";
import {
  MEMORY_OBSERVATION_EVENT_TYPE,
  parseMemoryObservationPayload,
  releaseMemoryObservation,
  settleMemoryObservation,
} from "../services/memory-observation-bridge.js";
import { createRequestContext } from "../utils/context.js";
import { logger } from "../utils/logger.js";

/**
 * Drains confirmed-constraint observations into memory evidence.
 *
 * Aggregation runs here rather than in the confirmation so it can never fail or
 * delay the request a member is waiting on. The outbox row is written in the
 * confirmation's transaction, so an observation survives a restart between the
 * confirmation committing and this worker running.
 */

/**
 * How long a claim is held before another worker may take the event back.
 *
 * An observation is a single short transaction, so anything beyond this means
 * the worker died rather than that it is still working.
 */
export const OBSERVATION_LEASE_SECONDS = 300;

/**
 * How many times an event is retried before it is parked as FAILED.
 *
 * A memory observation is not worth an unbounded retry budget: the evidence it
 * carries is redundant by design, while an event that can never succeed blocks
 * every later observation behind it and starves the maintenance sweep, which
 * only runs when the queue is empty.
 */
export const OBSERVATION_MAX_ATTEMPTS = 5;

/** Backoff before a failed event becomes claimable again. */
export const OBSERVATION_RETRY_BACKOFF_SECONDS = 60;

/**
 * Claims one row by moving it to PROCESSING in the same statement that selects
 * it, so two workers cannot take the same observation.
 *
 * A crash mid-handler leaves the row PROCESSING with an old `processed_at`, and
 * the next pass reclaims it — the event is never lost. Redelivery is safe
 * because the episode id is idempotent: a replay of an observation that already
 * landed comes back as DUPLICATE_EPISODE instead of counting twice.
 */
const CLAIM_OBSERVATION_SQL = [
  "UPDATE outbox_events",
  "SET status = 'PROCESSING', processed_at = NOW(), attempt_count = attempt_count + 1",
  "WHERE id = (",
  "  SELECT id FROM outbox_events",
  "  WHERE event_type = $1",
  "    AND (",
  "      (status = 'PENDING' AND next_attempt_at <= NOW())",
  "      OR (status = 'PROCESSING' AND processed_at < NOW() - ($2 * INTERVAL '1 second'))",
  "    )",
  "  ORDER BY next_attempt_at ASC, created_at ASC",
  "  FOR UPDATE SKIP LOCKED LIMIT 1",
  ")",
  "RETURNING event_id, payload, attempt_count",
].join("\n");

type ClaimedRow = { event_id: string; payload: unknown; attempt_count: number };

/**
 * Processes at most one pending observation.
 *
 * Returns `true` when a row was handled, so the Worker loop can poll instead of
 * spinning when the queue is empty.
 */
export async function processNextMemoryObservation(): Promise<boolean> {
  const rows = await rawDb.unsafe<ClaimedRow[]>(
    CLAIM_OBSERVATION_SQL,
    [MEMORY_OBSERVATION_EVENT_TYPE, OBSERVATION_LEASE_SECONDS],
  );
  const claimed = rows[0];
  if (!claimed) return false;

  const payload = parseMemoryObservationPayload(claimed.payload);
  if (!payload) {
    // A row this process cannot read will never become readable, so retrying
    // would only hide the fault.
    logger.error({ eventId: claimed.event_id }, "Memory observation payload is unreadable");
    await settleMemoryObservation(claimed.event_id, "FAILED", "UnreadablePayload");
    return true;
  }

  try {
    const [profile] = await db.select({ id: userProfiles.id })
      .from(userProfiles)
      .where(eq(userProfiles.userId, payload.userId))
      .limit(1);

    if (!profile) {
      // Nothing to attach a suggestion to. Not a failure — a member can confirm
      // trip constraints before ever opening their profile — so the row settles
      // rather than being retried until the lease expires forever.
      await settleMemoryObservation(claimed.event_id, "PROCESSED");
      return true;
    }

    const observedAt = new Date(payload.observedAt);
    const result = await observeBehavior({
      ctx: createRequestContext(payload.userId),
      userId: payload.userId,
      profileId: profile.id,
      fieldKey: payload.fieldKey,
      value: payload.value,
      episodeId: payload.episodeId,
      tripId: payload.tripId,
      observedAt: Number.isNaN(observedAt.getTime()) ? undefined : observedAt,
    });

    // REJECTED and DUPLICATE_EPISODE are ordinary outcomes, not errors: the
    // value may sit outside the memory catalog's range, or the member may have
    // confirmed this same value in this trip already.
    logger.debug({
      eventId: claimed.event_id,
      outcome: result.outcome,
    }, "Memory observation processed");
    await settleMemoryObservation(claimed.event_id, "PROCESSED");
    return true;
  } catch (error) {
    const errorClass = (error as Error).name;

    if (claimed.attempt_count >= OBSERVATION_MAX_ATTEMPTS) {
      // Parked, not deleted: the row stays readable as a dead letter. Retrying
      // it forever would block every observation queued behind it.
      logger.error({
        eventId: claimed.event_id,
        attempts: claimed.attempt_count,
        errorClass,
      }, "Memory observation exhausted its retries; parking it as failed");
      await settleMemoryObservation(claimed.event_id, "FAILED", errorClass);
      return true;
    }

    // Backed off rather than requeued immediately, so a failing event cannot
    // be re-claimed on the very next pass. Only the error class is recorded; a
    // message could carry the confirmed value.
    logger.error({
      eventId: claimed.event_id,
      attempts: claimed.attempt_count,
      errorClass,
    }, "Memory observation failed, backing off before retry");
    await releaseMemoryObservation(
      claimed.event_id,
      OBSERVATION_RETRY_BACKOFF_SECONDS,
      errorClass,
    );
    return true;
  }
}
