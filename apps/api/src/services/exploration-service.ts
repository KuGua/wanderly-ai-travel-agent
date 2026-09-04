import { db } from "../db/database.js";
import { chatThreads, sharedTrips, tripMembers } from "../db/schema.js";
import { recordAudit } from "./audit-service.js";
import {
  claimIdempotency,
  completeIdempotency,
  loadIdempotencyResult,
} from "./idempotency-service.js";
import { buildDefaultThreadTitle, type ThreadTitleLocale } from "./thread-title-service.js";
import { buildTripTitle } from "./trip-title-service.js";
import { metrics } from "../observability/metrics.js";
import { ApiError } from "../middleware/error-handler.js";
import type { RequestContext } from "../utils/context.js";

// Drizzle transaction callback parameter type. Aliased for readability.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export type ExplorationStartResult = {
  tripId: string;
  defaultThreadId: string;
  wasCreated: boolean;
};

/**
 * Stable idempotency key scoped to (user, requestId). The global unique
 * constraint on `idempotency_records.idempotency_key` would otherwise
 * collide across users sharing the same UUIDv4, which is harmless but
 * noisy to debug. Prefixing with `exploration:<userId>:` keeps the row
 * count meaningful and per-user without changing the table shape.
 */
function idempotencyKey(userId: string, requestId: string): string {
  return `exploration:${userId}:${requestId}`;
}

/**
 * Atomically provision a DRAFT Trip + creator membership + default private
 * thread for an authenticated user. Idempotent on `(userId, requestId)`:
 *
 *   * First call → creates the Trip + member + thread, returns `wasCreated: true`.
 *   * Replay with the same `requestId` → returns the existing Trip id with
 *     `wasCreated: false`.  No new audit row is written.
 *   * Concurrent first calls → the loser receives `409 Conflict` and may
 *     retry with the same `requestId` to read the cached result.
 */
export async function startExploration(params: {
  ctx: RequestContext;
  userId: string;
  requestId: string;
  locale: ThreadTitleLocale;
}): Promise<ExplorationStartResult> {
  const key = idempotencyKey(params.userId, params.requestId);
  const locale = params.locale;

  // Fast path: replay reads the cached result without touching business tables.
  const cached = await loadIdempotencyResult(key);
  if (cached) {
    const payload = cached.resultPayload as { tripId?: string; threadId?: string };
    if (payload.tripId && payload.threadId) {
      return {
        tripId: payload.tripId,
        defaultThreadId: payload.threadId,
        wasCreated: false,
      };
    }
  }

  return await db.transaction(async (tx) => {
    const claim = await claimIdempotency(tx, {
      key,
      entityType: "exploration_start",
      ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
    });

    if (!claim) {
      // Another concurrent caller claimed the key first. Their transaction
      // may not yet be visible to this one, so the cached read above may
      // be empty. Surface a conflict so the client retries; the retry
      // hits the fast path.
      throw new ApiError(
        409,
        "Conflict",
        "EXPLORATION_START_IN_PROGRESS: retry with the same requestId",
      );
    }

    const [trip] = await tx.insert(sharedTrips).values({
      // The draft row has no destinations or dates yet, so buildTripTitle
      // returns the locale-appropriate planner default. Once the brief is
      // filled in, the activate path will rebuild a destination-aware name.
      name: buildTripTitle({
        destinationCandidates: [],
        travelDateStart: null,
        travelDateEnd: null,
        locale,
      }),
      nameSource: "AUTO",
      titleLocale: locale,
      createdBy: params.userId,
      status: "DRAFT",
      departureCities: [],
      destinationCandidates: [],
      travelDateStart: null,
      travelDateEnd: null,
    }).returning();

    await tx.insert(tripMembers).values({
      tripId: trip.id,
      userId: params.userId,
      role: "CREATOR",
      isRequired: true,
    });

    const [thread] = await tx.insert(chatThreads).values({
      ownerUserId: params.userId,
      tripId: trip.id,
      scope: "TRIP",
      isDefault: true,
      title: buildDefaultThreadTitle(locale),
      titleSource: "AUTO",
      titleLocale: locale,
    }).returning();

    metrics.inc("thread_title_writes_total", {
      source: "deterministic",
      result: "applied",
    });

    await recordAudit({
      ctx: params.ctx,
      action: "EXPLORATION_START",
      actorUserId: params.userId,
      tripId: trip.id,
      summary: { idempotencyOutcome: "created" },
      tx,
    });
    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_DEFAULT_THREAD_PROVISION",
      actorUserId: params.userId,
      tripId: trip.id,
      summary: { threadId: thread.id, source: "exploration_start" },
      tx,
    });

    await completeIdempotency(tx, key, "exploration_start", trip.id, {
      tripId: trip.id,
      threadId: thread.id,
    });

    return {
      tripId: trip.id,
      defaultThreadId: thread.id,
      wasCreated: true,
    };
  });
}

// Re-exported so tests can build transactions explicitly if they need to.
export type ExplorationTx = Tx;
