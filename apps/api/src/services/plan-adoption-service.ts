import { eq, and } from "drizzle-orm";
import { db } from "../db/database.js";
import {
  planAdoptionVotes,
  itineraryPlans,
  tripMembers,
  memberConfirmations,
  sharedTrips,
} from "../db/schema.js";
import { recordAudit } from "./audit-service.js";
import { activateProposedPlan } from "./planning-service.js";
import {
  claimIdempotency,
  completeIdempotency,
} from "./idempotency-service.js";
import { getTripMode } from "./trip-mode-service.js";
import { metrics } from "../observability/metrics.js";
import { ApiError } from "../middleware/error-handler.js";
import type { RequestContext } from "../utils/context.js";
import type {
  PlanAdoptionDecision,
} from "../types/schemas.js";

/**
 * Team Agent 协作编排 — plan adoption vote service (spec §3.5, §5.3, §6.2).
 *
 * Phase 2 交付 castVote。Phase 4 完成后与 booking sandbox 整合、与 `member_confirmations` 完全分离。
 *
 * 不变量（spec §1.8）：
 *  - ACTIVE 仍是唯一可进入既有确认/booking 的状态；
 *  - 任何 required member 在投票窗口期内 `NEEDS_CHANGES` 阻止采用；
 *  - 同一 plan 在同一 quorum 内最多一次 ACTIVE 转换（race-safe by transaction + partial unique）。
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;

export class PlanAdoptionServiceError extends Error {
  readonly statusCode: 400 | 403 | 404 | 409 | 422 = 422;
  readonly code:
    | "INVALID_IDEMPOTENCY_KEY"
    | "PLAN_NOT_FOUND"
    | "PLAN_NOT_VOTABLE"
    | "FORBIDDEN"
    | "PLAN_ADOPTED"
    | "NOT_SOLO"
    | "PLAN_NOT_PROPOSED";

  constructor(
    code: PlanAdoptionServiceError["code"],
    message: string,
  ) {
    super(message);
    this.name = "PlanAdoptionServiceError";
    this.code = code;
  }
}

function idempotencyKeyFor(planId: string, userId: string, requestKey: string): string {
  return `plan_adoption_vote:${planId}:${userId}:${requestKey}`;
}

function ensureRequestKey(raw: string | undefined, fallback: string): string {
  const candidate = raw ?? fallback;
  if (!IDEMPOTENCY_KEY_PATTERN.test(candidate)) {
    throw new PlanAdoptionServiceError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency key must match /^[A-Za-z0-9:_-]{1,256}$/",
    );
  }
  return candidate;
}

interface LockedPlan {
  id: string;
  tripId: string;
  status: "DRAFT" | "ACTIVE" | "PROPOSED" | "STALE" | "SUPERSEDED";
}

async function lockPlan(tx: Tx, planId: string): Promise<LockedPlan> {
  const [plan] = await tx.select({
    id: itineraryPlans.id,
    tripId: itineraryPlans.tripId,
    status: itineraryPlans.status,
  }).from(itineraryPlans)
    .where(eq(itineraryPlans.id, planId))
    .for("update")
    .limit(1);
  if (!plan) {
    throw new PlanAdoptionServiceError("PLAN_NOT_FOUND", "Plan not found");
  }
  return plan;
}

async function requireMember(tx: Tx, tripId: string, userId: string): Promise<{ isRequired: boolean }> {
  const [member] = await tx.select({
    isRequired: tripMembers.isRequired,
  }).from(tripMembers).where(and(
    eq(tripMembers.tripId, tripId),
    eq(tripMembers.userId, userId),
  )).limit(1);
  if (!member) {
    throw new PlanAdoptionServiceError("FORBIDDEN", "Voter must be an active trip member");
  }
  return member;
}

export interface CountVotesResult {
  votesAccepted: number;
  votesRequired: number;
  hasBlocker: boolean;
}

async function countVotes(tx: Tx, tripId: string, planId: string): Promise<CountVotesResult> {
  const required = await tx.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(
      eq(tripMembers.tripId, tripId),
      eq(tripMembers.isRequired, true),
    ));
  const votes = await tx.select({
    userId: planAdoptionVotes.userId,
    decision: planAdoptionVotes.decision,
  }).from(planAdoptionVotes)
    .where(eq(planAdoptionVotes.planId, planId));
  const acceptors = new Set(
    votes.filter(v => v.decision === "ACCEPT").map(v => v.userId),
  );
  const acceptedRequired = required.filter(r => acceptors.has(r.userId)).length;
  const blocker = votes.some(v => v.decision === "NEEDS_CHANGES");
  return {
    votesAccepted: acceptedRequired,
    votesRequired: required.length,
    hasBlocker: blocker,
  };
}

export interface CastVoteOutcome {
  outcome: "CAST" | "ADOPTED" | "BLOCKED";
  votesAccepted: number;
  votesRequired: number;
}

/**
 * Cast a single vote. Idempotent on (planId, userId, idempotencyKey).
 * Re-vote is allowed (re-cast) until ACTIVE — UI handles radio state.
 */
export async function castVote(params: {
  ctx: RequestContext;
  planId: string;
  userId: string;
  decision: PlanAdoptionDecision;
  idempotencyKey: string;
}): Promise<CastVoteOutcome> {
  const requestKey = ensureRequestKey(params.idempotencyKey, `${params.decision}-${Date.now()}`);
  const fullKey = idempotencyKeyFor(params.planId, params.userId, requestKey);

  return db.transaction(async (tx) => {
    const plan = await lockPlan(tx, params.planId);
    if (plan.status === "ACTIVE") {
      throw new PlanAdoptionServiceError("PLAN_ADOPTED", "Plan is already ACTIVE");
    }
    if (plan.status !== "PROPOSED") {
      throw new PlanAdoptionServiceError(
        "PLAN_NOT_VOTABLE",
        `Plan status is ${plan.status}; votes are only accepted on PROPOSED plans`,
      );
    }
    await requireMember(tx, plan.tripId, params.userId);

    const claim = await claimIdempotency(tx, { key: fullKey, entityType: "plan_adoption_vote" });
    if (!claim) {
      const tally = await countVotes(tx, plan.tripId, params.planId);
      return {
        outcome: tally.votesAccepted >= tally.votesRequired && tally.votesRequired > 0
          ? "ADOPTED"
          : (tally.hasBlocker ? "BLOCKED" : "CAST"),
        votesAccepted: tally.votesAccepted,
        votesRequired: tally.votesRequired,
      };
    }

    const [existing] = await tx.select().from(planAdoptionVotes)
      .where(and(
        eq(planAdoptionVotes.planId, params.planId),
        eq(planAdoptionVotes.userId, params.userId),
      )).limit(1);
    if (existing) {
      await tx.update(planAdoptionVotes)
        .set({ decision: params.decision, updatedAt: new Date() })
        .where(and(
          eq(planAdoptionVotes.planId, params.planId),
          eq(planAdoptionVotes.userId, params.userId),
        ));
    } else {
      await tx.insert(planAdoptionVotes).values({
        planId: params.planId,
        userId: params.userId,
        decision: params.decision,
      });
    }

    await recordAudit({
      ctx: params.ctx,
      action: "PLAN_ADOPTION_VOTED",
      actorUserId: params.userId,
      tripId: plan.tripId,
      planId: plan.id,
      summary: { decision: params.decision, planStatusAtVote: plan.status },
      tx,
    });

    const tally = await countVotes(tx, plan.tripId, params.planId);
    let outcome: CastVoteOutcome["outcome"];
    if (tally.hasBlocker) {
      outcome = "BLOCKED";
    } else if (tally.votesRequired > 0 && tally.votesAccepted >= tally.votesRequired) {
      // Unanimous ACCEPT — delegate to the single source of truth for status flips.
      // (records the PLAN_ADOPTED audit and supersedes concurrent PROPOSED plans.)
      await activateProposedPlan({ ctx: params.ctx, planId: params.planId, tx });
      const [updated] = await tx.select({ status: itineraryPlans.status })
        .from(itineraryPlans)
        .where(eq(itineraryPlans.id, params.planId))
        .limit(1);
      outcome = updated?.status === "ACTIVE" ? "ADOPTED" : "CAST";
    } else {
      outcome = "CAST";
    }

    await completeIdempotency(tx, fullKey, "plan_adoption_vote", params.planId, {
      outcome,
      votesAccepted: tally.votesAccepted,
      votesRequired: tally.votesRequired,
    });

    metrics.inc("plan_adoption_vote_total", {
      decision: params.decision === "ACCEPT" ? "accept" : "needs_changes",
      result: outcome === "ADOPTED" ? "adopted"
        : outcome === "BLOCKED" ? "blocked"
        : "cast",
    });

    return {
      outcome,
      votesAccepted: tally.votesAccepted,
      votesRequired: tally.votesRequired,
    };
  });
}

/** Member-safe read model: never disclose another voter's identity or choice. */
export async function getVoteSummary(params: { planId: string; userId: string }): Promise<{
  planId: string;
  votesAccepted: number;
  votesRequired: number;
  hasBlocker: boolean;
  currentUserDecision: PlanAdoptionDecision | null;
}> {
  return db.transaction(async (tx) => {
    const plan = await lockPlan(tx, params.planId);
    await requireMember(tx, plan.tripId, params.userId);
    const tally = await countVotes(tx, plan.tripId, params.planId);
    const [ownVote] = await tx.select({ decision: planAdoptionVotes.decision })
      .from(planAdoptionVotes)
      .where(and(eq(planAdoptionVotes.planId, params.planId), eq(planAdoptionVotes.userId, params.userId)))
      .limit(1);
    return { planId: params.planId, ...tally, currentUserDecision: ownVote?.decision ?? null };
  });
}

/**
 * Phase 3 — Solo plan adoption for `SOLO` (1 required-member) trips.
 *
 * Single round-trip transaction: insert the owner's `member_confirmations`
 * row (status `CONFIRMED` — the post-adoption confirmation record, NOT the
 * pre-adoption vote), upsert the `plan_adoption_votes` row with `ACCEPT`,
 * and call `activateProposedPlan` so the `PROPOSED → ACTIVE` transition is
 * driven by the same single source of truth as the team flow.
 *
 * Rejects:
 * - non-SOLO trips with `NOT_SOLO` (403)
 * - non-PROPOSED / already-ACTIVE plans with `PLAN_NOT_PROPOSED` / `PLAN_ADOPTED`
 * - non-required callers with `FORBIDDEN` (403)
 */
export async function soloAdoptProposedPlan(params: {
  ctx: RequestContext;
  planId: string;
  userId: string;
}): Promise<{ planId: string; status: "ACTIVE" }> {
  return db.transaction(async (tx) => {
    const plan = await lockPlan(tx, params.planId);

    const mode = await getTripMode(tx, plan.tripId);
    if (mode !== "SOLO") {
      throw new PlanAdoptionServiceError(
        "NOT_SOLO",
        `Plan ${params.planId} belongs to a TEAM trip — use POST /plans/:planId/adoption-votes`,
      );
    }
    if (plan.status === "ACTIVE") {
      throw new PlanAdoptionServiceError("PLAN_ADOPTED", "Plan is already ACTIVE");
    }
    if (plan.status !== "PROPOSED") {
      throw new PlanAdoptionServiceError(
        "PLAN_NOT_PROPOSED",
        `Plan status is ${plan.status}; solo adoption requires PROPOSED`,
      );
    }
    await requireMember(tx, plan.tripId, params.userId);

    // Solo adoption is a single-owner quorum — optional members may observe
    // but never vote. `requireMember` only checks membership; explicitly
    // gate on `isRequired` here.
    const [membership] = await tx.select({ isRequired: tripMembers.isRequired })
      .from(tripMembers)
      .where(and(eq(tripMembers.tripId, plan.tripId), eq(tripMembers.userId, params.userId)))
      .limit(1);
    if (!membership?.isRequired) {
      throw new PlanAdoptionServiceError(
        "FORBIDDEN",
        "Solo adoption requires the single required (owner) member",
      );
    }

    // Insert (or upsert) the owner's post-adoption confirmation. The
    // `(planId, userId)` unique index makes this idempotent.
    await tx.insert(memberConfirmations).values({
      planId: params.planId,
      userId: params.userId,
      tripId: plan.tripId,
      status: "CONFIRMED",
      decidedAt: new Date(),
    }).onConflictDoUpdate({
      target: [memberConfirmations.planId, memberConfirmations.userId],
      set: { status: "CONFIRMED", decidedAt: new Date() },
    });

    // Upsert the adoption vote row (castVote does this too; we mirror its
    // shape so the existing audit + tally logic stays consistent).
    const [existingVote] = await tx.select().from(planAdoptionVotes)
      .where(and(
        eq(planAdoptionVotes.planId, params.planId),
        eq(planAdoptionVotes.userId, params.userId),
      )).limit(1);
    if (existingVote) {
      await tx.update(planAdoptionVotes)
        .set({ decision: "ACCEPT", updatedAt: new Date() })
        .where(and(
          eq(planAdoptionVotes.planId, params.planId),
          eq(planAdoptionVotes.userId, params.userId),
        ));
    } else {
      await tx.insert(planAdoptionVotes).values({
        planId: params.planId,
        userId: params.userId,
        decision: "ACCEPT",
      });
    }

    await recordAudit({
      ctx: params.ctx,
      action: "PLAN_ADOPTION_VOTED",
      actorUserId: params.userId,
      tripId: plan.tripId,
      planId: plan.id,
      summary: { decision: "ACCEPT" as PlanAdoptionDecision, planStatusAtVote: plan.status, path: "solo" },
      tx,
    });

    await activateProposedPlan({ ctx: params.ctx, planId: params.planId, tx });

    const [updated] = await tx.select({ status: itineraryPlans.status })
      .from(itineraryPlans)
      .where(eq(itineraryPlans.id, params.planId))
      .limit(1);
    const finalStatus = updated?.status ?? "PROPOSED";

    await recordAudit({
      ctx: params.ctx,
      action: "PLAN_ADOPTED",
      actorUserId: params.userId,
      tripId: plan.tripId,
      planId: plan.id,
      summary: { path: "solo", finalStatus },
      tx,
    });

    metrics.inc("solo_plan_adoption_total", {
      outcome: finalStatus === "ACTIVE" ? "adopted" : "stale_plan",
    });
    metrics.inc("plan_adoption_vote_total", {
      decision: "accept",
      result: finalStatus === "ACTIVE" ? "adopted" : "stale_plan",
    });

    if (finalStatus !== "ACTIVE") {
      throw new PlanAdoptionServiceError("PLAN_NOT_PROPOSED", `Solo adoption did not activate the plan (status=${finalStatus})`);
    }
    return { planId: params.planId, status: "ACTIVE" as const };
  });
}

/**
 * Convert `PlanAdoptionServiceError` to `ApiError` for the route layer. Phase 3
 * adds `NOT_SOLO` (403) and `PLAN_NOT_PROPOSED` (409).
 */
export function planAdoptionErrorToApiError(err: PlanAdoptionServiceError): ApiError {
  const status = err.code === "FORBIDDEN" || err.code === "NOT_SOLO" ? 403
    : err.code === "PLAN_ADOPTED" ? 409
    : err.code === "PLAN_NOT_FOUND" ? 404
    : err.code === "PLAN_NOT_VOTABLE" || err.code === "PLAN_NOT_PROPOSED" ? 409
    : 422;
  return new ApiError(status, status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 409 ? "Conflict" : "Unprocessable Entity", err.message);
}

void sharedTrips; // re-exported for type narrowing in route handlers.
