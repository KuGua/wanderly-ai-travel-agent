import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";

import { db } from "../db/database.js";
import { memoryProposals } from "../db/schema.js";
import type { RequestContext } from "../utils/context.js";
import { recordAudit } from "./audit-service.js";
import { claimIdempotency } from "./idempotency-service.js";
import { MemoryFieldRejectedError, replaceFact, type PreferenceFact } from "./preference-fact-service.js";
import { validateMemoryFieldValue } from "../memory/memory-field-catalog.js";
import { computeActivation } from "../memory/memory-activation.js";
import { withMemorySpan } from "../memory/memory-spans.js";
import { metrics } from "../observability/metrics.js";
import {
  MEMORY_ACTIVATION_POLICY_V1,
  resolveMemoryActivationPolicy,
  type MemoryActivationPolicy,
} from "../memory/memory-activation-policy.js";

/**
 * MemoryProposalService — the lifecycle of behaviour-derived candidates.
 *
 * A proposal is never authoritative: only the owner confirming one creates a
 * preference fact (§1.1 decision 4). Activation ranks candidates; it never
 * rewrites what the user has stated.
 *
 * Evidence is kept as an aggregate — a total count, first/last dates, and a
 * bounded UTC-day window — never as a behavioural timeline (§3.2).
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Trip ids retained purely so distinct-trip evidence can be counted. */
const MAX_CONTRIBUTING_TRIPS = 8;

const MS_PER_DAY = 86_400_000;

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function parseUtcDay(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseUtcDay(to).getTime() - parseUtcDay(from).getTime()) / MS_PER_DAY);
}

/** Stable hash of a candidate value, for pending uniqueness and cooldown. */
export function hashProposedValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 32);
}

export type MemoryProposal = {
  id: string;
  fieldKey: string;
  proposedValue: unknown;
  observationCount: number;
  distinctEpisodeCount: number;
  distinctTripCount: number;
  status: "PENDING" | "CONFIRMED" | "DISMISSED" | "EXPIRED";
  scoringVersion: string;
  expiresAt: Date;
  updatedAt: Date;
};

/**
 * Public view of a proposal.
 *
 * Deliberately omits the observation window, contributing trip ids, activation
 * and the value hash: §5.4 forbids showing timestamps, trip names, scores or
 * internal evidence references.
 */
function toProposal(row: typeof memoryProposals.$inferSelect): MemoryProposal {
  return {
    id: row.id,
    fieldKey: row.fieldKey,
    proposedValue: row.proposedValue,
    observationCount: row.observationCount,
    distinctEpisodeCount: row.distinctEpisodeCount,
    distinctTripCount: row.distinctTripCount,
    status: row.status,
    scoringVersion: row.scoringVersion,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  };
}

type CandidateRow = Pick<
  typeof memoryProposals.$inferSelect,
  "observationCount" | "distinctEpisodeCount" | "distinctTripCount"
  | "firstObservedOn" | "lastObservedOn" | "recentObservedOn"
>;

export type CandidateEvaluation = {
  activation: number;
  surfaceable: boolean;
  /** Which gate held it back, for tests and diagnostics. Never user-facing. */
  blockedBy: "OBSERVATIONS" | "EPISODES" | "TRIPS" | "SPAN" | "ACTIVATION" | null;
};

/** Evaluates the §3.6 trigger rule for one candidate. */
export function evaluateCandidate(
  row: CandidateRow,
  policy: MemoryActivationPolicy,
  now: Date,
): CandidateEvaluation {
  const { activation } = computeActivation(
    {
      observationCount: row.observationCount,
      firstObservedOn: parseUtcDay(row.firstObservedOn),
      recentObservedOn: row.recentObservedOn.map(parseUtcDay),
    },
    { decay: policy.decay, recentDepth: policy.recentDepth, now },
  );

  if (row.observationCount < policy.minimumIndependentObservations) {
    return { activation, surfaceable: false, blockedBy: "OBSERVATIONS" };
  }
  if (row.distinctEpisodeCount < policy.minimumIndependentObservations) {
    return { activation, surfaceable: false, blockedBy: "EPISODES" };
  }
  if (row.distinctTripCount < policy.minimumDistinctTrips) {
    return { activation, surfaceable: false, blockedBy: "TRIPS" };
  }
  if (daysBetween(row.firstObservedOn, row.lastObservedOn) < policy.minimumEvidenceSpanDays) {
    return { activation, surfaceable: false, blockedBy: "SPAN" };
  }
  if (activation < policy.activationThreshold) {
    return { activation, surfaceable: false, blockedBy: "ACTIVATION" };
  }
  return { activation, surfaceable: true, blockedBy: null };
}

/**
 * The proposals the owner should actually be shown.
 *
 * Activation is recomputed on read, never read back from storage (§3.5
 * constraint 5). When several candidates compete for one field, only the
 * leader is returned, and only if it clears the runner-up by `candidateMargin`.
 */
export async function listSurfaceableProposals(
  userId: string,
  options: { now?: Date; policy?: MemoryActivationPolicy; tx?: Tx } = {},
): Promise<MemoryProposal[]> {
  const now = options.now ?? new Date();
  const policy = options.policy ?? resolveMemoryActivationPolicy();
  const target = options.tx ?? db;

  const rows = await target.select().from(memoryProposals)
    .where(and(
      eq(memoryProposals.userId, userId),
      eq(memoryProposals.status, "PENDING"),
      // Filtered on read for the same reason confirmation re-checks it: the
      // sweep is periodic, so PENDING alone does not mean "still offered".
      gt(memoryProposals.expiresAt, now),
    ));

  const byField = new Map<string, { row: typeof rows[number]; activation: number }[]>();
  for (const row of rows) {
    const evaluated = evaluateCandidate(row, policy, now);
    if (!evaluated.surfaceable) continue;
    const bucket = byField.get(row.fieldKey) ?? [];
    bucket.push({ row, activation: evaluated.activation });
    byField.set(row.fieldKey, bucket);
  }

  const surfaced: MemoryProposal[] = [];
  for (const candidates of byField.values()) {
    candidates.sort((a, b) => b.activation - a.activation);
    const [leader, runnerUp] = candidates;
    // Without a clear leader we say nothing and keep aggregating, rather than
    // asking the owner to arbitrate between two inferred habits.
    if (runnerUp && leader.activation - runnerUp.activation < policy.candidateMargin) continue;
    surfaced.push(toProposal(leader.row));
  }
  return surfaced;
}

/** Every pending proposal, surfaceable or not. Owner-scoped. */
export async function listPendingProposals(userId: string, tx?: Tx): Promise<MemoryProposal[]> {
  const target = tx ?? db;
  const rows = await target.select().from(memoryProposals)
    .where(and(eq(memoryProposals.userId, userId), eq(memoryProposals.status, "PENDING")));
  return rows.map(toProposal);
}

/**
 * Terminal states must not keep a behaviour trail. Counts survive because they
 * are aggregate metadata; the dated window and trip references do not.
 */
function clearedEvidence() {
  return { recentObservedOn: [] as string[], contributingTripIds: [] as string[] };
}

/**
 * Moves lapsed proposals to EXPIRED, clearing their evidence and starting a
 * cooldown so an ignored suggestion does not reappear immediately (§5.7).
 */
export async function expireStaleProposals(
  now: Date = new Date(),
  options: { policy?: MemoryActivationPolicy; tx?: Tx } = {},
): Promise<number> {
  const policy = options.policy ?? MEMORY_ACTIVATION_POLICY_V1;
  const target = options.tx ?? db;
  const rows = await target.update(memoryProposals)
    .set({
      status: "EXPIRED",
      resolvedAt: now,
      updatedAt: now,
      cooldownUntil: new Date(now.getTime() + policy.dismissalCooldownDays * MS_PER_DAY),
      ...clearedEvidence(),
    })
    .where(and(eq(memoryProposals.status, "PENDING"), lt(memoryProposals.expiresAt, now)))
    .returning({ id: memoryProposals.id });
  return rows.length;
}

export type ObserveInput = {
  ctx: RequestContext;
  userId: string;
  profileId: string;
  fieldKey: string;
  value: unknown;
  /**
   * Stable id of the server-confirmed action. Independence is decided by this
   * id through existing idempotency — never inferred from elapsed time (§3.2).
   */
  episodeId: string;
  /** Trip the action completed in, for distinct-trip evidence. */
  tripId: string;
  observedAt?: Date;
  policy?: MemoryActivationPolicy;
};

export type ObserveResult =
  | { outcome: "REJECTED"; reason: "UNREGISTERED_FIELD" | "SENSITIVE_FIELD" | "INVALID_VALUE" }
  | { outcome: "DUPLICATE_EPISODE" }
  | { outcome: "IN_COOLDOWN" }
  | { outcome: "AGGREGATED"; proposal: MemoryProposal } & CandidateEvaluation;

/**
 * Records one server-confirmed observation of a habit.
 *
 * Callers must pass an action the product already completed — never raw chat,
 * model output or an unconfirmed UI event (§3.2).
 */
export async function observeBehavior(input: ObserveInput): Promise<ObserveResult> {
  return withMemorySpan(
    "memory.proposal.aggregate",
    { operation: "observe", source: "behavior_aggregation" },
    async () => {
      const result = await aggregateObservation(input);
      metrics.inc("memory_proposals_total", {
        outcome: outcomeLabel(result),
        source: "behavior_aggregation",
      });
      return {
        result,
        outcome: outcomeLabel(result),
        // The observation window is capped, so a long-running habit drops its
        // oldest dates rather than growing a timeline.
        truncated: result.outcome === "AGGREGATED"
          && result.proposal.observationCount > MEMORY_ACTIVATION_POLICY_V1.recentDepth,
      };
    },
  );
}

/** Bounded label for a result; never the field, value or activation. */
function outcomeLabel(result: ObserveResult): string {
  if (result.outcome !== "AGGREGATED") return result.outcome.toLowerCase();
  return result.proposal.observationCount === 1 ? "created" : "aggregated";
}

async function aggregateObservation(input: ObserveInput): Promise<ObserveResult> {
  const validation = validateMemoryFieldValue(input.fieldKey, input.value, "BEHAVIOR_AGGREGATION");
  if (!validation.ok) return { outcome: "REJECTED", reason: validation.reason };

  const policy = input.policy ?? resolveMemoryActivationPolicy();
  const observedAt = input.observedAt ?? new Date();
  const observedOn = utcDay(observedAt);
  const value = validation.value;
  const valueHash = hashProposedValue(value);

  return db.transaction(async (tx): Promise<ObserveResult> => {
    // Replaying a completed action must not add evidence. The claim is
    // race-safe, so two concurrent replays cannot both count.
    const claimed = await claimIdempotency(tx, {
      key: `memory-observation:${input.userId}:${input.fieldKey}:${valueHash}:${input.episodeId}`,
      entityType: "memory_observation",
    });
    if (!claimed) return { outcome: "DUPLICATE_EPISODE" };

    // A dismissed or expired suggestion stays suppressed for its cooldown.
    const [cooling] = await tx.select().from(memoryProposals)
      .where(and(
        eq(memoryProposals.userId, input.userId),
        eq(memoryProposals.fieldKey, input.fieldKey),
        eq(memoryProposals.proposedValueHash, valueHash),
        gt(memoryProposals.cooldownUntil, observedAt),
      ))
      .limit(1);
    if (cooling) return { outcome: "IN_COOLDOWN" };

    const [existing] = await tx.select().from(memoryProposals)
      .where(and(
        eq(memoryProposals.userId, input.userId),
        eq(memoryProposals.fieldKey, input.fieldKey),
        eq(memoryProposals.proposedValueHash, valueHash),
        eq(memoryProposals.status, "PENDING"),
      ))
      .for("update");

    if (!existing) {
      const [inserted] = await tx.insert(memoryProposals).values({
        userId: input.userId,
        profileId: input.profileId,
        fieldKey: input.fieldKey,
        proposedValue: value as never,
        proposedValueHash: valueHash,
        observationCount: 1,
        firstObservedOn: observedOn,
        lastObservedOn: observedOn,
        recentObservedOn: [observedOn],
        distinctEpisodeCount: 1,
        distinctTripCount: 1,
        contributingTripIds: [input.tripId],
        scoringVersion: policy.scoringVersion,
        status: "PENDING",
        expiresAt: new Date(observedAt.getTime() + policy.proposalExpiryDays * MS_PER_DAY),
      }).returning();

      await recordAudit({
        ctx: input.ctx,
        action: "MEMORY_PROPOSAL_CREATE",
        actorUserId: input.userId,
        summary: {
          fieldCategory: validation.definition.category,
          source: "BEHAVIOR_AGGREGATION",
          scoringVersion: policy.scoringVersion,
        },
        tx,
      });

      return {
        outcome: "AGGREGATED",
        proposal: toProposal(inserted),
        ...evaluateCandidate(inserted, policy, observedAt),
      };
    }

    // Keep only the most recent `recentDepth` dates, oldest first.
    const window = [...existing.recentObservedOn, observedOn].sort().slice(-policy.recentDepth);

    const trips = existing.contributingTripIds.includes(input.tripId)
      ? existing.contributingTripIds
      : [...existing.contributingTripIds, input.tripId].slice(0, MAX_CONTRIBUTING_TRIPS);

    const [updated] = await tx.update(memoryProposals).set({
      observationCount: existing.observationCount + 1,
      distinctEpisodeCount: existing.distinctEpisodeCount + 1,
      distinctTripCount: trips.length,
      contributingTripIds: trips,
      recentObservedOn: window,
      firstObservedOn: observedOn < existing.firstObservedOn ? observedOn : existing.firstObservedOn,
      lastObservedOn: observedOn > existing.lastObservedOn ? observedOn : existing.lastObservedOn,
      expiresAt: new Date(observedAt.getTime() + policy.proposalExpiryDays * MS_PER_DAY),
      updatedAt: observedAt,
    }).where(eq(memoryProposals.id, existing.id)).returning();

    return {
      outcome: "AGGREGATED",
      proposal: toProposal(updated),
      ...evaluateCandidate(updated, policy, observedAt),
    };
  });
}

export type ResolveResult =
  | { outcome: "NOT_FOUND" }
  | { outcome: "ALREADY_RESOLVED"; proposal: MemoryProposal }
  /** Lapsed before it was answered. Distinct so the UI can say so. */
  | { outcome: "EXPIRED"; proposal: MemoryProposal }
  | { outcome: "CONFIRMED"; proposal: MemoryProposal; fact: PreferenceFact }
  | { outcome: "DISMISSED"; proposal: MemoryProposal };

/**
 * Confirms a pending proposal, creating the active fact in the same
 * transaction. Terminal states return idempotently, so a retried or racing
 * confirmation cannot create a second fact.
 */
export async function confirmProposal(input: {
  ctx: RequestContext;
  userId: string;
  proposalId: string;
  /** Injectable clock, matching the other lifecycle entry points. */
  now?: Date;
}): Promise<ResolveResult> {
  return db.transaction(async (tx): Promise<ResolveResult> => {
    const [row] = await tx.select().from(memoryProposals)
      .where(and(eq(memoryProposals.id, input.proposalId), eq(memoryProposals.userId, input.userId)))
      .for("update");
    if (!row) return { outcome: "NOT_FOUND" };
    if (row.status !== "PENDING") return { outcome: "ALREADY_RESOLVED", proposal: toProposal(row) };

    // Expiry is a property of elapsed time, so a row can be past it while the
    // sweep has not yet run — the Worker may be stopped, or an event may be
    // parked ahead of it. Confirming here would resurrect a suggestion the
    // policy already retired, so the check belongs at the decision, not only in
    // the sweep.
    const attemptedAt = input.now ?? new Date();
    if (row.expiresAt <= attemptedAt) {
      // Retire it here rather than only refusing: the row is already past its
      // life, and leaving it PENDING lets the same lapsed suggestion be offered
      // and refused again until the sweep happens to run.
      const policy = resolveMemoryActivationPolicy();
      const [retired] = await tx.update(memoryProposals).set({
        status: "EXPIRED",
        resolvedAt: attemptedAt,
        updatedAt: attemptedAt,
        cooldownUntil: new Date(
          attemptedAt.getTime() + policy.dismissalCooldownDays * MS_PER_DAY,
        ),
        ...clearedEvidence(),
      }).where(eq(memoryProposals.id, row.id)).returning();
      return { outcome: "EXPIRED", proposal: toProposal(retired) };
    }

    // Re-validate: the catalogue may have tightened since the proposal was raised.
    const validation = validateMemoryFieldValue(row.fieldKey, row.proposedValue, "PROPOSAL_CONFIRMATION");
    if (!validation.ok) throw new MemoryFieldRejectedError(row.fieldKey, validation.reason);

    const now = attemptedAt;
    const fact = await replaceFact({
      ctx: input.ctx,
      userId: input.userId,
      profileId: row.profileId,
      fieldKey: row.fieldKey,
      value: row.proposedValue,
      path: "PROPOSAL_CONFIRMATION",
      confirmedAt: now,
      tx,
    });

    const [updated] = await tx.update(memoryProposals).set({
      status: "CONFIRMED",
      resolvedAt: now,
      resolvedFactId: fact.id,
      updatedAt: now,
      ...clearedEvidence(),
    }).where(eq(memoryProposals.id, row.id)).returning();

    await recordAudit({
      ctx: input.ctx,
      action: "MEMORY_PROPOSAL_CONFIRM",
      actorUserId: input.userId,
      summary: {
        fieldCategory: validation.definition.category,
        observationCount: row.observationCount,
        scoringVersion: row.scoringVersion,
      },
      tx,
    });

    return { outcome: "CONFIRMED", proposal: toProposal(updated), fact };
  });
}

/** Dismisses a pending proposal and suppresses it for the cooldown window. */
export async function dismissProposal(input: {
  ctx: RequestContext;
  userId: string;
  proposalId: string;
  policy?: MemoryActivationPolicy;
}): Promise<ResolveResult> {
  const policy = input.policy ?? MEMORY_ACTIVATION_POLICY_V1;
  return db.transaction(async (tx): Promise<ResolveResult> => {
    const [row] = await tx.select().from(memoryProposals)
      .where(and(eq(memoryProposals.id, input.proposalId), eq(memoryProposals.userId, input.userId)))
      .for("update");
    if (!row) return { outcome: "NOT_FOUND" };
    if (row.status !== "PENDING") return { outcome: "ALREADY_RESOLVED", proposal: toProposal(row) };

    const now = new Date();
    const [updated] = await tx.update(memoryProposals).set({
      status: "DISMISSED",
      resolvedAt: now,
      updatedAt: now,
      cooldownUntil: new Date(now.getTime() + policy.dismissalCooldownDays * MS_PER_DAY),
      ...clearedEvidence(),
    }).where(eq(memoryProposals.id, row.id)).returning();

    await recordAudit({
      ctx: input.ctx,
      action: "MEMORY_PROPOSAL_DISMISS",
      actorUserId: input.userId,
      summary: { observationCount: row.observationCount },
      tx,
    });

    return { outcome: "DISMISSED", proposal: toProposal(updated) };
  });
}

/**
 * Drops pending candidates for a field the owner has just set directly.
 *
 * Once the user states a value, suggestions built from behaviour that
 * contradicted the old one are stale evidence, not pending questions (§5.8).
 */
export async function clearPendingProposalsForField(input: {
  userId: string;
  fieldKey: string;
  tx?: Tx;
}): Promise<number> {
  const target = input.tx ?? db;
  const rows = await target.delete(memoryProposals)
    .where(and(
      eq(memoryProposals.userId, input.userId),
      eq(memoryProposals.fieldKey, input.fieldKey),
      eq(memoryProposals.status, "PENDING"),
    ))
    .returning({ id: memoryProposals.id });
  return rows.length;
}

/** Removes every proposal for a field, used when the owner deletes its memory. */
export async function deleteProposalsForField(input: {
  userId: string;
  fieldKey: string;
  tx?: Tx;
}): Promise<number> {
  const target = input.tx ?? db;
  const rows = await target.delete(memoryProposals)
    .where(and(eq(memoryProposals.userId, input.userId), eq(memoryProposals.fieldKey, input.fieldKey)))
    .returning({ id: memoryProposals.id });
  return rows.length;
}
