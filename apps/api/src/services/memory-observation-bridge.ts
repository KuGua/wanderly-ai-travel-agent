import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { outboxEvents } from "../db/schema.js";
import { metrics } from "../observability/metrics.js";
import { pinoInstance } from "../observability/telemetry.js";
import { hashProposedValue } from "./memory-proposal-service.js";

/**
 * Bridge from a confirmed trip constraint to a long-term memory observation
 * (docs/long-term-memory-implementation.md §3.2).
 *
 * The single evidence source is an owner confirming a constraint the agent
 * proposed for them. Plan adoption, member confirmation and group decisions are
 * deliberately excluded: those express agreement with a package or a group
 * compromise, not a preference about the field, and treating them as habit is
 * the failure mode §9 lists first.
 *
 * The two catalogs were written independently and agree on neither key names
 * nor value shapes, so the mapping is spelled out here rather than inferred.
 * Anything not in the table produces no observation at all.
 */

export const MEMORY_OBSERVATION_EVENT_TYPE = "MEMORY_OBSERVATION";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Constraint field -> memory field, with the reader that unwraps the
 * constraint's object value into the scalar or array memory stores.
 */
const CONSTRAINT_TO_MEMORY: Readonly<Record<string, {
  fieldKey: string;
  read: (value: Record<string, unknown>) => unknown;
}>> = Object.freeze({
  no_red_eye: { fieldKey: "no_red_eye", read: (v) => v.enabled },
  accommodation_style: { fieldKey: "accommodation_style", read: (v) => v.style },
  // The two catalogs named the same concept differently.
  travel_pace: { fieldKey: "trip_pace", read: (v) => v.pace },
  interests: { fieldKey: "interests", read: (v) => v.topics },
});

export type MemoryObservationCandidate = {
  fieldKey: string;
  value: unknown;
};

/**
 * Translates a confirmed constraint into the memory field and value it implies,
 * or `null` when the constraint has no memory counterpart.
 *
 * Returning `null` rather than throwing is deliberate: this runs inside the
 * confirmation transaction, and a constraint the memory catalog does not model
 * must never fail the confirmation. The constraint catalog is also the wider of
 * the two — it accepts an accommodation style (`boutique`) that memory does
 * not — so a value outside the memory schema drops here and is validated again
 * by `observeBehavior` before it can become evidence.
 */
export function memoryObservationFor(
  constraintFieldKey: string,
  valueJson: unknown,
): MemoryObservationCandidate | null {
  const outcome = explainMemoryObservation(constraintFieldKey, valueJson);
  return outcome.candidate;
}

/**
 * Why a confirmed constraint produced no observation.
 *
 * `not_in_catalog` is the designed no-op — most constraints are deliberately
 * not habits. The other two mean a *caller* got the shape wrong: the field is
 * one we track, but the value did not arrive the way the mapping reads it.
 * That is a bug in the writer, and before this was instrumented it looked
 * exactly like success (see docs — a seed passing `"relaxed"` instead of
 * `{ pace: "relaxed" }` wrote nothing, threw nothing, and logged nothing).
 */
export type MemoryObservationSkipReason =
  | "not_in_catalog"
  | "value_not_an_object"
  | "value_shape_mismatch";

export function explainMemoryObservation(
  constraintFieldKey: string,
  valueJson: unknown,
): { candidate: MemoryObservationCandidate | null; skipReason: MemoryObservationSkipReason | null } {
  const mapping = CONSTRAINT_TO_MEMORY[constraintFieldKey];
  if (!mapping) return { candidate: null, skipReason: "not_in_catalog" };
  if (!valueJson || typeof valueJson !== "object" || Array.isArray(valueJson)) {
    return { candidate: null, skipReason: "value_not_an_object" };
  }

  const value = mapping.read(valueJson as Record<string, unknown>);
  if (value === undefined || value === null) {
    return { candidate: null, skipReason: "value_shape_mismatch" };
  }
  return { candidate: { fieldKey: mapping.fieldKey, value }, skipReason: null };
}

/**
 * Reports a skip without ever disturbing the caller.
 *
 * This runs inside the confirmation transaction, so it must not throw: an
 * unregistered metric label would otherwise turn a diagnostic into a failed
 * confirmation. The field key is a catalog key, never a user value, so it is
 * safe to log; the value itself is never touched.
 */
function reportObservationSkip(constraintFieldKey: string, reason: MemoryObservationSkipReason): void {
  try {
    metrics.inc("memory_observation_skipped_total", { reason });
    if (reason !== "not_in_catalog") {
      pinoInstance.warn(
        { runtime_event: { component: "memory", event: "observation_skipped", reason, constraintFieldKey } },
        "Confirmed constraint produced no memory observation",
      );
    }
  } catch {
    // Diagnostics must never fail a confirmation the member is waiting on.
  }
}

/**
 * Stable episode id for one confirmed decision.
 *
 * Independence is decided by this id, never by elapsed time (§3.2). Because it
 * carries no timestamp, re-confirming the same value on the same field in the
 * same trip is the same episode and adds no evidence — a member cannot build a
 * habit by toggling a setting back and forth.
 */
export function memoryEpisodeId(input: {
  tripId: string;
  fieldKey: string;
  ownerUserId: string;
  value: unknown;
}): string {
  return [
    input.tripId,
    input.fieldKey,
    input.ownerUserId,
    hashProposedValue(input.value),
  ].join(":");
}

export type MemoryObservationPayload = {
  userId: string;
  tripId: string;
  fieldKey: string;
  value: unknown;
  episodeId: string;
  observedAt: string;
};

/**
 * Records the observation for asynchronous aggregation.
 *
 * Written in the confirmation's own transaction so an observation cannot be
 * lost if the process dies, and drained by the Worker so aggregation can never
 * fail or slow down the confirmation the member is waiting on.
 *
 * The payload carries the field and its confirmed value only — no action path,
 * no chat, no proposal or plan reference (§1.1 decision 6).
 */
export async function enqueueMemoryObservation(tx: Tx, input: {
  ownerUserId: string;
  tripId: string;
  constraintFieldKey: string;
  valueJson: unknown;
  observedAt?: Date;
}): Promise<MemoryObservationPayload | null> {
  const { candidate, skipReason } = explainMemoryObservation(input.constraintFieldKey, input.valueJson);
  if (!candidate) {
    reportObservationSkip(input.constraintFieldKey, skipReason ?? "not_in_catalog");
    return null;
  }

  const payload: MemoryObservationPayload = {
    userId: input.ownerUserId,
    tripId: input.tripId,
    fieldKey: candidate.fieldKey,
    value: candidate.value,
    episodeId: memoryEpisodeId({
      tripId: input.tripId,
      fieldKey: candidate.fieldKey,
      ownerUserId: input.ownerUserId,
      value: candidate.value,
    }),
    observedAt: (input.observedAt ?? new Date()).toISOString(),
  };

  await tx.insert(outboxEvents).values({
    eventId: randomUUID(),
    eventType: MEMORY_OBSERVATION_EVENT_TYPE,
    payload: payload as unknown as Record<string, unknown>,
  });
  return payload;
}

/** Parses an outbox payload back, rejecting rows that do not carry the shape. */
export function parseMemoryObservationPayload(raw: unknown): MemoryObservationPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.userId !== "string" || typeof row.tripId !== "string") return null;
  if (typeof row.fieldKey !== "string" || typeof row.episodeId !== "string") return null;
  if (typeof row.observedAt !== "string") return null;
  return {
    userId: row.userId,
    tripId: row.tripId,
    fieldKey: row.fieldKey,
    value: row.value,
    episodeId: row.episodeId,
    observedAt: row.observedAt,
  };
}

/** Marks one outbox row terminal. `lastError` records the class, never a value. */
export async function settleMemoryObservation(
  eventId: string,
  status: "PROCESSED" | "FAILED",
  lastError?: string,
): Promise<void> {
  await db.update(outboxEvents)
    .set({ status, processedAt: new Date(), lastError: lastError ?? null })
    .where(eq(outboxEvents.eventId, eventId));
}

/**
 * Returns a claimed row to the queue after a transient failure.
 *
 * `backoffSeconds` is what stops a failing event from being re-claimed on the
 * next pass and starving everything queued behind it.
 */
export async function releaseMemoryObservation(
  eventId: string,
  backoffSeconds = 0,
  lastError?: string,
): Promise<void> {
  await db.update(outboxEvents)
    .set({
      status: "PENDING",
      processedAt: null,
      nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000),
      lastError: lastError ?? null,
    })
    .where(eq(outboxEvents.eventId, eventId));
}
