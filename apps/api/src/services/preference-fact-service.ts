import { and, eq } from "drizzle-orm";

import { db } from "../db/database.js";
import { preferenceFacts } from "../db/schema.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";
import { invalidateForPersonalFact } from "./memory-invalidation-service.js";
import { withMemorySpan } from "../memory/memory-spans.js";
import { metrics } from "../observability/metrics.js";
import {
  memoryFieldDefinition,
  validateMemoryFieldValue,
  type MemoryWritePath,
} from "../memory/memory-field-catalog.js";

/**
 * PreferenceFactService — owner-only personal stable facts.
 *
 * Facts are append-and-supersede rather than update-in-place: replacing a value
 * writes a new ACTIVE row and marks the previous one SUPERSEDED, keeping a
 * version chain. A partial unique index enforces at most one ACTIVE fact per
 * (user, field), so a concurrent replacement fails loudly instead of leaving
 * two live values.
 *
 * Audit summaries carry the field *category* and never the value, per §7.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PreferenceFact = {
  id: string;
  fieldKey: string;
  value: unknown;
  category: "PREFERENCE" | "CONSTRAINT";
  source: "PROFILE_FORM" | "PROPOSAL_CONFIRMATION";
  status: "ACTIVE" | "SUPERSEDED";
  confirmedAt: Date | null;
  updatedAt: Date;
};

export class MemoryFieldRejectedError extends Error {
  constructor(
    readonly fieldKey: string,
    readonly reason: "UNREGISTERED_FIELD" | "SENSITIVE_FIELD" | "INVALID_VALUE",
  ) {
    super(`Memory field rejected (${reason}): ${fieldKey}`);
    this.name = "MemoryFieldRejectedError";
  }
}

function toFact(row: typeof preferenceFacts.$inferSelect): PreferenceFact {
  return {
    id: row.id,
    fieldKey: row.fieldKey,
    value: row.fieldValue,
    category: row.category,
    source: row.source,
    status: row.status,
    confirmedAt: row.confirmedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

/** Active facts for one owner. Never call this for another user's id. */
export async function listActiveFacts(userId: string, tx?: Tx): Promise<PreferenceFact[]> {
  const target = tx ?? db;
  const rows = await target.select().from(preferenceFacts)
    .where(and(eq(preferenceFacts.userId, userId), eq(preferenceFacts.status, "ACTIVE")));
  return rows.map(toFact);
}

export type ReplaceFactInput = {
  ctx: RequestContext;
  userId: string;
  profileId: string;
  fieldKey: string;
  value: unknown;
  path: Extract<MemoryWritePath, "PROFILE_FORM" | "PROPOSAL_CONFIRMATION">;
  /** Set when the fact is created by confirming a proposal. */
  confirmedAt?: Date;
  tx?: Tx;
};

/**
 * Writes a new active fact and supersedes the previous one for that field.
 *
 * Runs inside a transaction so the supersede and the insert cannot be observed
 * apart; callers already inside one pass `tx` to join it.
 */
export async function replaceFact(input: ReplaceFactInput): Promise<PreferenceFact> {
  return withMemorySpan(
    "memory.fact.mutate",
    { operation: "replace", source: input.path.toLowerCase() },
    async () => {
      const result = await replaceFactInner(input);
      metrics.inc("memory_fact_mutations_total", {
        operation: "replace",
        source: input.path === "PROFILE_FORM" ? "profile_form" : "proposal_confirmation",
      });
      // A stated fact supersedes the previous version and stales the trips
      // that were planned on it.
      return { result, outcome: "replaced", invalidated: true };
    },
  );
}

async function replaceFactInner(input: ReplaceFactInput): Promise<PreferenceFact> {
  const validation = validateMemoryFieldValue(input.fieldKey, input.value, input.path);
  if (!validation.ok) throw new MemoryFieldRejectedError(input.fieldKey, validation.reason);
  const definition = validation.definition;

  const run = async (tx: Tx): Promise<PreferenceFact> => {
    const [previous] = await tx.select().from(preferenceFacts)
      .where(and(
        eq(preferenceFacts.userId, input.userId),
        eq(preferenceFacts.fieldKey, input.fieldKey),
        eq(preferenceFacts.status, "ACTIVE"),
      ))
      .for("update");

    if (previous) {
      await tx.update(preferenceFacts)
        .set({ status: "SUPERSEDED", updatedAt: new Date() })
        .where(eq(preferenceFacts.id, previous.id));
    }

    const [inserted] = await tx.insert(preferenceFacts).values({
      userId: input.userId,
      profileId: input.profileId,
      fieldKey: input.fieldKey,
      fieldValue: validation.value as never,
      category: definition.category,
      source: input.path,
      status: "ACTIVE",
      confirmedAt: input.confirmedAt ?? null,
      supersedesFactId: previous?.id ?? null,
    }).returning();

    // Any trip that was allowed to see this field must re-plan (§6).
    await invalidateForPersonalFact({
      ctx: input.ctx,
      tx,
      userId: input.userId,
      fieldKey: input.fieldKey,
      reason: "preference_fact_changed",
    });

    await recordAudit({
      ctx: input.ctx,
      action: "PREFERENCE_FACT_UPDATE",
      actorUserId: input.userId,
      // Category and source only — never the value, per §7.
      summary: {
        fieldCategory: definition.category,
        source: input.path,
        superseded: Boolean(previous),
      },
      tx,
    });

    return toFact(inserted);
  };

  return input.tx ? run(input.tx) : db.transaction(run);
}

/**
 * Hard-deletes a fact's whole version chain.
 *
 * §7 requires the stored value to be gone, not just hidden, so this removes the
 * rows rather than marking them. Historical snapshots are immutable and are not
 * rewritten; they simply stop being exported to new agent runs.
 */
export async function deleteFact(input: {
  ctx: RequestContext;
  userId: string;
  factId: string;
  tx?: Tx;
}): Promise<boolean> {
  return withMemorySpan(
    "memory.fact.mutate",
    { operation: "delete", source: "profile_form" },
    async () => {
      const deleted = await deleteFactInner(input);
      if (deleted) {
        metrics.inc("memory_fact_mutations_total", {
          operation: "delete", source: "profile_form",
        });
      }
      return {
        result: deleted,
        outcome: deleted ? "deleted" : "not_found",
        invalidated: deleted,
      };
    },
  );
}

async function deleteFactInner(input: {
  ctx: RequestContext;
  userId: string;
  factId: string;
  tx?: Tx;
}): Promise<boolean> {
  const run = async (tx: Tx): Promise<boolean> => {
    const [target] = await tx.select().from(preferenceFacts)
      .where(and(eq(preferenceFacts.id, input.factId), eq(preferenceFacts.userId, input.userId)));
    if (!target) return false;

    const definition = memoryFieldDefinition(target.fieldKey);

    // Remove every version of this field for this owner, so no superseded row
    // keeps the value alive.
    await tx.delete(preferenceFacts).where(and(
      eq(preferenceFacts.userId, input.userId),
      eq(preferenceFacts.fieldKey, target.fieldKey),
    ));

    await invalidateForPersonalFact({
      ctx: input.ctx,
      tx,
      userId: input.userId,
      fieldKey: target.fieldKey,
      reason: "preference_fact_deleted",
    });

    await recordAudit({
      ctx: input.ctx,
      action: "PREFERENCE_FACT_DELETE",
      actorUserId: input.userId,
      summary: { fieldCategory: definition?.category ?? "PREFERENCE" },
      tx,
    });
    return true;
  };

  return input.tx ? run(input.tx) : db.transaction(run);
}
