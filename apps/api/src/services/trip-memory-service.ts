import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { tripConstraintFacts, tripMembers } from "../db/schema.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";
import { MemoryFieldRejectedError } from "./preference-fact-service.js";
import { memoryFieldDefinition, validateMemoryFieldValue } from "../memory/memory-field-catalog.js";
import { invalidateForTripMemory } from "./memory-invalidation-service.js";

/**
 * TripMemoryService — memory that belongs to one trip and never leaves it.
 *
 * Storage is `trip_constraint_facts`, shared with team-orchestration
 * constraints (migration 0026). The `kind` column keeps the two apart so each
 * retains its own active-uniqueness rule, and one projection serves both.
 *
 * Two shape adaptations follow from sharing that table:
 *
 * - `value_json` is an object there, while a memory value may be a scalar or an
 *   array, so values are stored wrapped as `{ value }` and unwrapped on read.
 * - `visibility` carries the sharing rule: a group decision is TEAM_VISIBLE,
 *   a personal override is ORCHESTRATOR_CONFIDENTIAL — owner-private until the
 *   trip's field-level consent exports it.
 *
 * Two kinds, per §3.3:
 *
 * - `PERSONAL_OVERRIDE` is a member's preference *for this trip*. It is owner-
 *   visible only, and reaches the Shared Agent solely through that trip's
 *   field-level consent projection.
 * - `GROUP_DECISION` is a collaborative decision visible to active members.
 *
 * Everything here is scoped by `tripId`. There is no cross-trip read: a value
 * saved on one trip is invisible to another by construction, not by filtering.
 *
 * Like personal facts, trip memory is append-and-supersede and does not decay.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type TripMemoryKind = "PERSONAL_OVERRIDE" | "GROUP_DECISION";

/** Matches constraint-proposal-service so both writers hash identically. */
function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

function wrap(value: unknown): Record<string, unknown> {
  return { value };
}

function unwrap(valueJson: Record<string, unknown>): unknown {
  return "value" in valueJson ? valueJson.value : valueJson;
}

function visibilityFor(kind: TripMemoryKind) {
  return kind === "GROUP_DECISION" ? "TEAM_VISIBLE" as const : "ORCHESTRATOR_CONFIDENTIAL" as const;
}

export type TripMemoryFact = {
  id: string;
  tripId: string;
  ownerUserId: string;
  kind: TripMemoryKind;
  fieldKey: string;
  value: unknown;
  source: "OWNER_SAVE" | "GROUP_COMMAND";
  status: "ACTIVE" | "SUPERSEDED" | "DELETED";
  updatedAt: Date;
};

export class TripMembershipError extends Error {
  constructor(readonly tripId: string, readonly userId: string) {
    super("Caller is not an active member of this trip");
    this.name = "TripMembershipError";
  }
}

function toFact(row: typeof tripConstraintFacts.$inferSelect): TripMemoryFact {
  return {
    id: row.id,
    tripId: row.tripId,
    ownerUserId: row.ownerUserId,
    kind: row.kind === "GROUP_DECISION" ? "GROUP_DECISION" : "PERSONAL_OVERRIDE",
    fieldKey: row.fieldKey,
    value: unwrap(row.valueJson),
    source: row.kind === "GROUP_DECISION" ? "GROUP_COMMAND" : "OWNER_SAVE",
    status: row.status === "ACTIVE" ? "ACTIVE" : "SUPERSEDED",
    updatedAt: row.supersededAt ?? row.createdAt,
  };
}

/**
 * Membership is checked on every call rather than trusted from the caller.
 * A non-member must not be able to read or write trip memory at all.
 */
export async function assertActiveMember(tripId: string, userId: string, tx?: Tx): Promise<void> {
  const target = tx ?? db;
  const [membership] = await target.select().from(tripMembers)
    .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, userId)))
    .limit(1);
  if (!membership) throw new TripMembershipError(tripId, userId);
}

/** The caller's own overrides for one trip. Never another member's. */
export async function listOverridesForOwner(
  tripId: string,
  ownerUserId: string,
  tx?: Tx,
): Promise<TripMemoryFact[]> {
  await assertActiveMember(tripId, ownerUserId, tx);
  const target = tx ?? db;
  const rows = await target.select().from(tripConstraintFacts)
    .where(and(
      eq(tripConstraintFacts.tripId, tripId),
      eq(tripConstraintFacts.ownerUserId, ownerUserId),
      eq(tripConstraintFacts.kind, "PERSONAL_OVERRIDE"),
      eq(tripConstraintFacts.status, "ACTIVE"),
    ));
  return rows.map(toFact);
}

/** Group decisions for one trip, visible to any active member. */
export async function listGroupDecisions(
  tripId: string,
  callerUserId: string,
  tx?: Tx,
): Promise<TripMemoryFact[]> {
  await assertActiveMember(tripId, callerUserId, tx);
  const target = tx ?? db;
  const rows = await target.select().from(tripConstraintFacts)
    .where(and(
      eq(tripConstraintFacts.tripId, tripId),
      eq(tripConstraintFacts.kind, "GROUP_DECISION"),
      eq(tripConstraintFacts.status, "ACTIVE"),
    ));
  return rows.map(toFact);
}

type SaveInput = {
  ctx: RequestContext;
  tripId: string;
  userId: string;
  fieldKey: string;
  value: unknown;
  tx?: Tx;
};

async function saveFact(
  input: SaveInput & { kind: TripMemoryKind; source: "OWNER_SAVE" | "GROUP_COMMAND" },
): Promise<TripMemoryFact> {
  const path = input.source === "OWNER_SAVE" ? "OWNER_SAVE" : "GROUP_COMMAND";
  const validation = validateMemoryFieldValue(input.fieldKey, input.value, path);
  if (!validation.ok) throw new MemoryFieldRejectedError(input.fieldKey, validation.reason);

  const run = async (tx: Tx): Promise<TripMemoryFact> => {
    await assertActiveMember(input.tripId, input.userId, tx);

    // A group decision is unique per trip; a personal override is unique per
    // member. Locking the current row keeps concurrent saves from leaving two
    // ACTIVE versions behind.
    const scope = input.kind === "GROUP_DECISION"
      ? and(
          eq(tripConstraintFacts.tripId, input.tripId),
          eq(tripConstraintFacts.kind, "GROUP_DECISION"),
          eq(tripConstraintFacts.fieldKey, input.fieldKey),
          eq(tripConstraintFacts.status, "ACTIVE"),
        )
      : and(
          eq(tripConstraintFacts.tripId, input.tripId),
          eq(tripConstraintFacts.ownerUserId, input.userId),
          eq(tripConstraintFacts.kind, "PERSONAL_OVERRIDE"),
          eq(tripConstraintFacts.fieldKey, input.fieldKey),
          eq(tripConstraintFacts.status, "ACTIVE"),
        );

    const [previous] = await tx.select().from(tripConstraintFacts).where(scope).for("update");
    if (previous) {
      await tx.update(tripConstraintFacts)
        .set({ status: "SUPERSEDED", supersededAt: new Date() })
        .where(eq(tripConstraintFacts.id, previous.id));
    }

    const valueJson = wrap(validation.value);
    const [inserted] = await tx.insert(tripConstraintFacts).values({
      tripId: input.tripId,
      ownerUserId: input.userId,
      kind: input.kind,
      fieldKey: input.fieldKey,
      valueJson,
      valueHash: hashValue(valueJson),
      // Memory is a preference, never a hard planning constraint.
      strength: "SOFT",
      visibility: visibilityFor(input.kind),
      revision: (previous?.revision ?? 0) + 1,
      status: "ACTIVE",
    }).returning();

    // A plan built on the previous value must not stay active (§6).
    await invalidateForTripMemory({
      ctx: input.ctx,
      tx,
      tripId: input.tripId,
      actorUserId: input.userId,
      reason: `trip_memory_${input.kind.toLowerCase()}_changed`,
    });

    await recordAudit({
      ctx: input.ctx,
      action: "TRIP_MEMORY_UPDATE",
      actorUserId: input.userId,
      tripId: input.tripId,
      // Category and kind only — never the value.
      summary: {
        fieldCategory: validation.definition.category,
        kind: input.kind,
        source: input.source,
        superseded: Boolean(previous),
      },
      tx,
    });

    return toFact(inserted);
  };

  return input.tx ? run(input.tx) : db.transaction(run);
}

/** Saves or replaces the caller's own preference for this trip. */
export function saveOverride(input: SaveInput): Promise<TripMemoryFact> {
  return saveFact({ ...input, kind: "PERSONAL_OVERRIDE", source: "OWNER_SAVE" });
}

/** Saves or replaces a whole-group decision for this trip. */
export function saveGroupDecision(input: SaveInput): Promise<TripMemoryFact> {
  return saveFact({ ...input, kind: "GROUP_DECISION", source: "GROUP_COMMAND" });
}

/**
 * Deletes trip memory the caller is entitled to remove.
 *
 * A member may delete their own override, or a group decision on their trip.
 * The rows are removed rather than flagged, so no superseded version keeps the
 * value alive (§7).
 */
export async function deleteTripMemory(input: {
  ctx: RequestContext;
  tripId: string;
  userId: string;
  factId: string;
  tx?: Tx;
}): Promise<boolean> {
  const run = async (tx: Tx): Promise<boolean> => {
    await assertActiveMember(input.tripId, input.userId, tx);

    const [target] = await tx.select().from(tripConstraintFacts)
      .where(and(
        eq(tripConstraintFacts.id, input.factId),
        eq(tripConstraintFacts.tripId, input.tripId),
      ));
    if (!target) return false;
    // Team-orchestration constraints are not this service's to remove.
    if (target.kind === "MEMBER_CONSTRAINT") return false;

    // Another member's personal override is not the caller's to delete.
    if (target.kind === "PERSONAL_OVERRIDE" && target.ownerUserId !== input.userId) return false;

    const scope = target.kind === "GROUP_DECISION"
      ? and(
          eq(tripConstraintFacts.tripId, input.tripId),
          eq(tripConstraintFacts.kind, "GROUP_DECISION"),
          eq(tripConstraintFacts.fieldKey, target.fieldKey),
        )
      : and(
          eq(tripConstraintFacts.tripId, input.tripId),
          eq(tripConstraintFacts.ownerUserId, input.userId),
          eq(tripConstraintFacts.kind, "PERSONAL_OVERRIDE"),
          eq(tripConstraintFacts.fieldKey, target.fieldKey),
        );

    await tx.delete(tripConstraintFacts).where(scope);

    await invalidateForTripMemory({
      ctx: input.ctx,
      tx,
      tripId: input.tripId,
      actorUserId: input.userId,
      reason: "trip_memory_deleted",
    });

    await recordAudit({
      ctx: input.ctx,
      action: "TRIP_MEMORY_DELETE",
      actorUserId: input.userId,
      tripId: input.tripId,
      summary: {
        fieldCategory: memoryFieldDefinition(target.fieldKey)?.category ?? "PREFERENCE",
        kind: target.kind,
      },
      tx,
    });
    return true;
  };

  return input.tx ? run(input.tx) : db.transaction(run);
}
