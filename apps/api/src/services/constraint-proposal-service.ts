import { createHash } from "node:crypto";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { db } from "../db/database.js";
import {
  tripConstraintProposals,
  tripConstraintFacts,
  tripMembers,
  sharedTrips,
  tripSearchPreferences,
  tripStaySearchPreferences,
  consentGrants,
  chatThreads,
  itineraryPlans,
} from "../db/schema.js";
import { enqueueMemoryObservation } from "./memory-observation-bridge.js";
import { recordAudit } from "./audit-service.js";
import {
  claimIdempotency,
  completeIdempotency,
  loadIdempotencyResult,
} from "./idempotency-service.js";
import { stalePlansAndConfirmationsForTrip } from "./consent-service.js";
import { acceptPlanningTask } from "../tasks/task-repository.js";
import { createConstraintSnapshot } from "./planning-service.js";
import {
  CONSTRAINT_FIELD_CATALOG,
  parseConstraintField,
  requiresResidualInferenceWarning,
} from "../policy/constraint-field-catalog.js";
import { metrics } from "../observability/metrics.js";
import type { RequestContext } from "../utils/context.js";
import type {
  ConstraintVisibility,
  ConstraintStrength,
  TripConstraintProposalSourceKind,
} from "../types/schemas.js";

/**
 * Team Agent 协作编排 — owner-private proposal lifecycle (spec §5.1, §5.2).
 *
 * 仅 owner 在私有对话中可生成 PENDING 候选；其他成员无法访问，也不参与下游投影。
 * confirm / dismiss / revoke 必须在同一事务内完成失效级联，否则旧 ACTIVE plan
 * 会保留指向陈旧 PENDING 行（spec §1.7）。
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

function stableUuidFromRequestKey(requestKey: string): string {
  const digest = createHash("sha256").update(`constraint-replan:${requestKey}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function idempotencyKeyFor(
  entity: string,
  tripId: string,
  userId: string,
  requestKey: string,
): string {
  return `trip_constraint_proposal:${entity}:${tripId}:${userId}:${requestKey}`;
}

function ensureRequestKey(raw: string | undefined): string {
  if (!raw || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new ConstraintProposalServiceError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency key must match /^[A-Za-z0-9:_-]{1,256}$/",
    );
  }
  return raw;
}

function visibilityLabel(visibility: ConstraintVisibility): "team_visible" | "orchestrator_confidential" {
  return visibility === "TEAM_VISIBLE" ? "team_visible" : "orchestrator_confidential";
}
function strengthLabel(strength: ConstraintStrength): "hard" | "soft" {
  return strength === "HARD" ? "hard" : "soft";
}

export class ConstraintProposalServiceError extends Error {
  readonly statusCode:
    | 400 | 403 | 404 | 409 | 422 = 422;
  readonly code:
    | "INVALID_IDEMPOTENCY_KEY"
    | "FORBIDDEN"
    | "TRIP_NOT_FOUND"
    | "PROPOSAL_NOT_FOUND"
    | "PROPOSAL_NOT_PENDING"
    | "UNKNOWN_FIELD"
    | "VALUE_INVALID"
    | "VISIBILITY_NOT_ALLOWED"
    | "STRENGTH_NOT_ALLOWED"
    | "NOT_PROPOSAL_ELIGIBLE";

  constructor(
    code: ConstraintProposalServiceError["code"],
    message: string,
  ) {
    super(message);
    this.name = "ConstraintProposalServiceError";
    this.code = code;
  }
}

async function requireOwnerMembership(tx: Tx, tripId: string, userId: string): Promise<void> {
  const [member] = await tx.select({ id: tripMembers.id }).from(tripMembers).where(and(
    eq(tripMembers.tripId, tripId),
    eq(tripMembers.userId, userId),
  )).limit(1);
  if (!member) {
    throw new ConstraintProposalServiceError("FORBIDDEN", "Owner must be an active member of the trip");
  }
}

async function requireTripExists(tx: Tx, tripId: string): Promise<void> {
  const [trip] = await tx.select({ id: sharedTrips.id }).from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
  if (!trip) {
    throw new ConstraintProposalServiceError("TRIP_NOT_FOUND", `Trip ${tripId} not found`);
  }
}

async function requireFieldConsent(
  tx: Tx,
  params: { tripId: string; userId: string; fieldKey: string; sourceKind: TripConstraintProposalSourceKind },
): Promise<void> {
  const descriptor = CONSTRAINT_FIELD_CATALOG[params.fieldKey as keyof typeof CONSTRAINT_FIELD_CATALOG];
  // A form submission is a direct per-Trip owner command. Only a proposal
  // derived by Personal Agent from a Profile field needs Profile consent.
  if (params.sourceKind !== "PERSONAL_AGENT" || !descriptor?.profileConsentRequired) return;

  const grants = await tx.select({ fieldList: consentGrants.fieldList }).from(consentGrants).where(and(
    eq(consentGrants.tripId, params.tripId),
    eq(consentGrants.userId, params.userId),
    eq(consentGrants.granted, true),
  ));
  if (!grants.some((grant) => grant.fieldList?.includes(params.fieldKey))) {
    throw new ConstraintProposalServiceError(
      "FORBIDDEN",
      `An active consent grant is required for field "${params.fieldKey}"`,
    );
  }
}

/**
 * Build the next immutable snapshot and accept its durable REPLAN run in the
 * same transaction as the fact mutation. This removes the old, unsafe route
 * contract that asked callers to supply a snapshot id and preference version.
 */
async function enqueueReplanForConstraintMutation(params: {
  tx: Tx;
  ctx: RequestContext;
  tripId: string;
  userId: string;
  requestId: string;
  trigger: string;
}): Promise<{ runId: string; queuedAt: Date }> {
  const [trip] = await params.tx.select().from(sharedTrips)
    .where(eq(sharedTrips.id, params.tripId))
    .for("update")
    .limit(1);
  if (!trip) throw new ConstraintProposalServiceError("TRIP_NOT_FOUND", "Trip not found");

  const requiredMembers = await params.tx.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(and(eq(tripMembers.tripId, params.tripId), eq(tripMembers.isRequired, true)));
  if (requiredMembers.length === 0) {
    throw new ConstraintProposalServiceError("FORBIDDEN", "A replan requires at least one required trip member");
  }

  const [preference] = await params.tx.select({ version: tripSearchPreferences.version })
    .from(tripSearchPreferences)
    .where(eq(tripSearchPreferences.tripId, params.tripId))
    .orderBy(desc(tripSearchPreferences.version))
    .limit(1);
  if (!preference) {
    throw new ConstraintProposalServiceError(
      "FORBIDDEN",
      "Confirmed flight search preferences are required before changing shared constraints",
    );
  }
  const [stayPreference] = process.env.PLAN_ENABLE_HOTEL === "true"
    ? await params.tx.select({ version: tripStaySearchPreferences.version }).from(tripStaySearchPreferences)
      .where(eq(tripStaySearchPreferences.tripId, params.tripId)).orderBy(desc(tripStaySearchPreferences.version)).limit(1)
    : [];
  if (process.env.PLAN_ENABLE_HOTEL === "true" && !stayPreference) {
    throw new ConstraintProposalServiceError("FORBIDDEN", "Confirmed stay search preferences are required before changing shared constraints");
  }

  const snapshotId = await createConstraintSnapshot({
    tripId: params.tripId,
    memberIds: requiredMembers.map((member) => member.userId),
    departureCities: trip.departureCities as string[],
    destinationCandidates: trip.destinationCandidates as string[],
    travelDateStart: trip.travelDateStart ?? undefined,
    travelDateEnd: trip.travelDateEnd ?? undefined,
    tx: params.tx,
  });
  const accepted = await acceptPlanningTask({
    ctx: params.ctx,
    tripId: params.tripId,
    userId: params.userId,
    snapshotId,
    flightSearchPreferencesVersion: preference.version,
    staySearchPreferencesVersion: stayPreference?.version,
    operation: "REPLAN",
    requestId: stableUuidFromRequestKey(params.requestId),
    tx: params.tx,
  });
  await recordAudit({
    ctx: params.ctx,
    action: "PLAN_REPLAN_ENQUEUED",
    actorUserId: params.userId,
    tripId: params.tripId,
    summary: { trigger: params.trigger, runId: accepted.runId },
    tx: params.tx,
  });
  return { runId: accepted.runId, queuedAt: new Date() };
}

interface ProposalEnvelope {
  fieldKey: string;
  valueJson: unknown;
  strength: ConstraintStrength;
  proposedVisibility: ConstraintVisibility;
  sourceKind: TripConstraintProposalSourceKind;
}

/**
 * Create a PENDING proposal. Owner-only; idempotency key required.
 */
export async function proposeConstraint(params: {
  ctx: RequestContext;
  tripId: string;
  ownerUserId: string;
  envelope: ProposalEnvelope;
  idempotencyKey: string;
}): Promise<{ proposalId: string }> {
  const requestKey = ensureRequestKey(params.idempotencyKey);

  // Pre-validate catalog shape — keeps `proposal` rows guaranteed to be writable.
  try {
    parseConstraintField({
      fieldKey: params.envelope.fieldKey,
      value: params.envelope.valueJson,
      visibility: params.envelope.proposedVisibility,
      strength: params.envelope.strength,
    });
  } catch {
    metrics.inc("trip_constraint_mutation_total", {
      operation: "propose",
      visibility: visibilityLabel(params.envelope.proposedVisibility),
      strength: strengthLabel(params.envelope.strength),
      result: "catalog_invalid",
    });
    throw new ConstraintProposalServiceError(
      "UNKNOWN_FIELD",
      `Catalog rejected proposed field "${params.envelope.fieldKey}"`,
    );
  }

  const fullKey = idempotencyKeyFor("propose", params.tripId, params.ownerUserId, requestKey);

  const replay = await loadIdempotencyResult(fullKey);
  if (replay?.resultPayload && typeof replay.resultPayload.proposalId === "string") {
    return { proposalId: replay.resultPayload.proposalId };
  }

  return db.transaction(async (tx) => {
    const claim = await claimIdempotency(tx, { key: fullKey, entityType: "trip_constraint_proposal" });
    if (!claim) {
      const again = await loadIdempotencyResult(fullKey);
      if (again?.resultPayload && typeof again.resultPayload.proposalId === "string") {
        return { proposalId: again.resultPayload.proposalId };
      }
      throw new ConstraintProposalServiceError(
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency record missing result payload — concurrent caller is in flight",
      );
    }

    await requireTripExists(tx, params.tripId);
    await requireOwnerMembership(tx, params.tripId, params.ownerUserId);

    const valueHash = hashValue(params.envelope.valueJson);
    const [existingPending] = await tx.select({ id: tripConstraintProposals.id }).from(tripConstraintProposals).where(and(
      eq(tripConstraintProposals.tripId, params.tripId),
      eq(tripConstraintProposals.ownerUserId, params.ownerUserId),
      eq(tripConstraintProposals.fieldKey, params.envelope.fieldKey),
      eq(tripConstraintProposals.valueHash, valueHash),
      eq(tripConstraintProposals.status, "PENDING"),
    )).limit(1);

    if (existingPending) {
      await completeIdempotency(tx, fullKey, "trip_constraint_proposal", existingPending.id, {
        proposalId: existingPending.id,
      });
      return { proposalId: existingPending.id };
    }

    const [created] = await tx.insert(tripConstraintProposals).values({
      tripId: params.tripId,
      ownerUserId: params.ownerUserId,
      fieldKey: params.envelope.fieldKey,
      valueJson: params.envelope.valueJson as Record<string, unknown>,
      valueHash,
      strength: params.envelope.strength,
      proposedVisibility: params.envelope.proposedVisibility,
      sourceKind: params.envelope.sourceKind,
    }).returning();

    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_CONSTRAINT_PROPOSED",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: {
        proposalId: created.id,
        fieldCategory: params.envelope.fieldKey,
        visibility: params.envelope.proposedVisibility,
        strength: params.envelope.strength,
        sourceKind: params.envelope.sourceKind,
      },
      tx,
    });

    await completeIdempotency(tx, fullKey, "trip_constraint_proposal", created.id, {
      proposalId: created.id,
    });
    metrics.inc("trip_constraint_mutation_total", {
      operation: "propose",
      visibility: visibilityLabel(params.envelope.proposedVisibility),
      strength: strengthLabel(params.envelope.strength),
      result: "success",
    });
    return { proposalId: created.id };
  });
}

/**
 * Owner-only dismissal of a PENDING proposal. No stale cascade, no REPLAN.
 */
export async function dismissConstraintProposal(params: {
  ctx: RequestContext;
  tripId: string;
  proposalId: string;
  ownerUserId: string;
  idempotencyKey: string;
}): Promise<void> {
  const requestKey = ensureRequestKey(params.idempotencyKey);
  const fullKey = idempotencyKeyFor("dismiss", params.tripId, params.ownerUserId, requestKey);

  await db.transaction(async (tx) => {
    const claim = await claimIdempotency(tx, { key: fullKey, entityType: "trip_constraint_proposal" });
    if (!claim) return; // Replay-safe: dismissal is idempotent terminal.

    await requireTripExists(tx, params.tripId);
    await requireOwnerMembership(tx, params.tripId, params.ownerUserId);

    const [proposal] = await tx.update(tripConstraintProposals)
      .set({ status: "DISMISSED", resolvedAt: new Date() })
      .where(and(
        eq(tripConstraintProposals.id, params.proposalId),
        eq(tripConstraintProposals.tripId, params.tripId),
        eq(tripConstraintProposals.ownerUserId, params.ownerUserId),
        eq(tripConstraintProposals.status, "PENDING"),
      )).returning({ id: tripConstraintProposals.id });

    if (!proposal) {
      throw new ConstraintProposalServiceError("PROPOSAL_NOT_PENDING", "Proposal is missing or already resolved");
    }

    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_CONSTRAINT_REVOKED",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: { proposalId: proposal.id, outcome: "dismissed" },
      tx,
    });

    await completeIdempotency(tx, fullKey, "trip_constraint_proposal", proposal.id, {
      dismissed: true, proposalId: proposal.id,
    });
  });
}

/**
 * Confirm a PENDING proposal. Writes new ACTIVE fact (revision+1); invalidates
 * ACTIVE plan / PROPOSED plan / adoption votes / in-flight REPLAN task;
 * enqueues exactly one REPLAN via outbox (when snapshot binding supplied).
 */
export async function confirmConstraintProposal(params: {
  ctx: RequestContext;
  tripId: string;
  proposalId: string;
  ownerUserId: string;
  visibility: ConstraintVisibility;
  strength: ConstraintStrength;
  idempotencyKey: string;
}): Promise<{
  factId: string;
  proposalId: string;
  replan: { runId: string; queuedAt: Date } | null;
}> {
  const requestKey = ensureRequestKey(params.idempotencyKey);
  // Note: catalog validation is re-applied inside the transaction after the
  // proposal row is locked, with the proposal's persisted `valueJson`. The
  // upfront catalog check here is intentionally skipped to avoid an early
  // throw on `_upfront` placeholder values.
  void params.visibility;
  void params.strength;

  const fullKey = idempotencyKeyFor("confirm", params.tripId, params.ownerUserId, requestKey);

  // Replay short-circuit (after first commit) so callers with retried idempotencyKey
  // get the original persisted entity_id without re-running.
  const replay = await loadIdempotencyResult(fullKey);
  if (replay?.resultPayload) {
    const payload = replay.resultPayload as Record<string, unknown>;
    if (typeof payload.factId === "string" && typeof payload.proposalId === "string") {
      return {
        factId: payload.factId,
        proposalId: payload.proposalId,
        replan: (payload.replan as { runId: string; queuedAt: Date } | null) ?? null,
      };
    }
  }

  return db.transaction(async (tx) => {
    const claim = await claimIdempotency(tx, { key: fullKey, entityType: "trip_constraint_proposal" });
    if (!claim) {
      const again = await loadIdempotencyResult(fullKey);
      if (again?.resultPayload) {
        const payload = again.resultPayload as Record<string, unknown>;
        if (typeof payload.factId === "string" && typeof payload.proposalId === "string") {
          return {
            factId: payload.factId,
            proposalId: payload.proposalId,
            replan: (payload.replan as { runId: string; queuedAt: Date } | null) ?? null,
          };
        }
      }
      throw new ConstraintProposalServiceError(
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency record missing result payload — concurrent caller is in flight",
      );
    }

    await requireTripExists(tx, params.tripId);
    await requireOwnerMembership(tx, params.tripId, params.ownerUserId);

    const [proposal] = await tx.select().from(tripConstraintProposals)
      .where(and(
        eq(tripConstraintProposals.id, params.proposalId),
        eq(tripConstraintProposals.tripId, params.tripId),
        eq(tripConstraintProposals.ownerUserId, params.ownerUserId),
      ))
      .for("update")
      .limit(1);

    if (!proposal) {
      throw new ConstraintProposalServiceError("PROPOSAL_NOT_FOUND", "Proposal not found");
    }
    if (proposal.status !== "PENDING") {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_PENDING",
        `Proposal is ${proposal.status}, not PENDING`,
      );
    }

    // Re-validate value against current catalog (catalog may have changed since propose).
    parseConstraintField({
      fieldKey: proposal.fieldKey,
      value: proposal.valueJson,
      visibility: params.visibility,
      strength: params.strength,
    });
    await requireFieldConsent(tx, {
      tripId: params.tripId, userId: params.ownerUserId, fieldKey: proposal.fieldKey, sourceKind: proposal.sourceKind,
    });

    const [latestFact] = await tx.select({ revision: tripConstraintFacts.revision })
      .from(tripConstraintFacts)
      .where(and(
        eq(tripConstraintFacts.tripId, params.tripId),
        eq(tripConstraintFacts.ownerUserId, params.ownerUserId),
        eq(tripConstraintFacts.fieldKey, proposal.fieldKey),
        eq(tripConstraintFacts.status, "ACTIVE"),
      ))
      .orderBy(sql`${tripConstraintFacts.revision} DESC`)
      .limit(1);
    const nextRevision = (latestFact?.revision ?? 0) + 1;

    if (latestFact) {
      await tx.update(tripConstraintFacts)
        .set({ status: "SUPERSEDED", supersededAt: new Date() })
        .where(and(
          eq(tripConstraintFacts.tripId, params.tripId),
          eq(tripConstraintFacts.ownerUserId, params.ownerUserId),
          eq(tripConstraintFacts.fieldKey, proposal.fieldKey),
          eq(tripConstraintFacts.status, "ACTIVE"),
        ));
    }

    const valueHash = hashValue(proposal.valueJson);

    const [fact] = await tx.insert(tripConstraintFacts).values({
      tripId: params.tripId,
      ownerUserId: params.ownerUserId,
      fieldKey: proposal.fieldKey,
      valueJson: proposal.valueJson as Record<string, unknown>,
      valueHash,
      strength: params.strength,
      visibility: params.visibility,
      revision: nextRevision,
      sourceProposalId: proposal.id,
      status: "ACTIVE",
    }).returning();

    await tx.update(tripConstraintProposals)
      .set({ status: "CONFIRMED", resolvedAt: new Date() })
      .where(and(
        eq(tripConstraintProposals.id, proposal.id),
        eq(tripConstraintProposals.status, "PENDING"),
      ));

    // The one place long-term memory takes evidence from behaviour: the owner
    // accepted a constraint the agent proposed for them
    // (docs/long-term-memory-implementation.md §3.2). Queued rather than
    // aggregated here so memory can never fail the confirmation, and skipped
    // silently for fields memory does not model.
    await enqueueMemoryObservation(tx, {
      ownerUserId: params.ownerUserId,
      tripId: params.tripId,
      constraintFieldKey: proposal.fieldKey,
      valueJson: proposal.valueJson,
    });

    await stalePlansAndConfirmationsForTrip(tx, {
      tripId: params.tripId,
      reason: `trip_constraint_confirmed:${proposal.fieldKey}:${params.visibility}`,
    });

    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_CONSTRAINT_CONFIRMED",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: {
        proposalId: proposal.id,
        factId: fact.id,
        revision: nextRevision,
        fieldCategory: proposal.fieldKey,
        visibility: params.visibility,
        strength: params.strength,
      },
      tx,
    });

    const replan = await enqueueReplanForConstraintMutation({
      tx, ctx: params.ctx, tripId: params.tripId, userId: params.ownerUserId,
      requestId: requestKey, trigger: "trip_constraint_confirmed",
    });

    await completeIdempotency(tx, fullKey, "trip_constraint_proposal", proposal.id, {
      factId: fact.id,
      proposalId: proposal.id,
      replan,
    });
    metrics.inc("trip_constraint_mutation_total", {
      operation: "confirm",
      visibility: visibilityLabel(params.visibility),
      strength: strengthLabel(params.strength),
      result: "success",
    });
    metrics.inc("plan_replan_total", {
      trigger: "trip_constraint_confirmed",
      result: "enqueued",
    });
    return { factId: fact.id, proposalId: proposal.id, replan };
  });
}

/**
 * Owner revokes an ACTIVE fact. Same stale cascade as confirm.
 */
export async function revokeConstraintFact(params: {
  ctx: RequestContext;
  tripId: string;
  factId: string;
  ownerUserId: string;
  idempotencyKey: string;
}): Promise<{ replan: { runId: string; queuedAt: Date } | null }> {
  const requestKey = ensureRequestKey(params.idempotencyKey);
  const fullKey = idempotencyKeyFor("revoke", params.tripId, params.ownerUserId, requestKey);
  const replay = await loadIdempotencyResult(fullKey);
  if (replay?.resultPayload) {
    const payload = replay.resultPayload as Record<string, unknown>;
    return { replan: (payload.replan as { runId: string; queuedAt: Date } | null) ?? null };
  }

  return db.transaction(async (tx) => {
    const claim = await claimIdempotency(tx, { key: fullKey, entityType: "trip_constraint_fact" });
    if (!claim) {
      const again = await loadIdempotencyResult(fullKey);
      if (again?.resultPayload) {
        const payload = again.resultPayload as Record<string, unknown>;
        return { replan: (payload.replan as { runId: string; queuedAt: Date } | null) ?? null };
      }
      throw new ConstraintProposalServiceError(
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency record missing result payload",
      );
    }

    await requireTripExists(tx, params.tripId);
    await requireOwnerMembership(tx, params.tripId, params.ownerUserId);

    const [fact] = await tx.select().from(tripConstraintFacts)
      .where(and(
        eq(tripConstraintFacts.id, params.factId),
        eq(tripConstraintFacts.tripId, params.tripId),
        eq(tripConstraintFacts.ownerUserId, params.ownerUserId),
        eq(tripConstraintFacts.status, "ACTIVE"),
      ))
      .for("update")
      .limit(1);

    if (!fact) {
      throw new ConstraintProposalServiceError("PROPOSAL_NOT_FOUND", "Active fact not found");
    }

    await tx.update(tripConstraintFacts)
      .set({ status: "REVOKED", revokedAt: new Date() })
      .where(eq(tripConstraintFacts.id, fact.id));

    await stalePlansAndConfirmationsForTrip(tx, {
      tripId: params.tripId,
      reason: `trip_constraint_revoked:${fact.fieldKey}:${fact.visibility}`,
    });

    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_CONSTRAINT_REVOKED",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: { factId: fact.id, fieldCategory: fact.fieldKey, visibility: fact.visibility },
      tx,
    });

    const replan = await enqueueReplanForConstraintMutation({
      tx, ctx: params.ctx, tripId: params.tripId, userId: params.ownerUserId,
      requestId: requestKey, trigger: "trip_constraint_revoked",
    });

    await completeIdempotency(tx, fullKey, "trip_constraint_fact", fact.id, { replan });
    metrics.inc("trip_constraint_mutation_total", {
      operation: "revoke",
      visibility: visibilityLabel(fact.visibility),
      strength: strengthLabel(fact.strength),
      result: "success",
    });
    metrics.inc("plan_replan_total", {
      trigger: "trip_constraint_revoked",
      result: "enqueued",
    });
    return { replan };
  });
}

/**
 * Direct (form-driven) upsert of a fact without a prior proposal.
 * Same stale cascade. Used in Phase 5 when owner edits a fact from the UI.
 */
export async function upsertConstraintFactDirect(params: {
  ctx: RequestContext;
  tripId: string;
  factId: string;
  ownerUserId: string;
  fieldKey: string;
  valueJson: unknown;
  visibility: ConstraintVisibility;
  strength: ConstraintStrength;
  expectedRevision?: number;
  idempotencyKey: string;
}): Promise<{ factId: string; replan: { runId: string; queuedAt: Date } | null }> {
  parseConstraintField({
    fieldKey: params.fieldKey,
    value: params.valueJson,
    visibility: params.visibility,
    strength: params.strength,
  });

  const requestKey = ensureRequestKey(params.idempotencyKey);
  const fullKey = idempotencyKeyFor("upsert", params.tripId, params.ownerUserId, requestKey);
  const replay = await loadIdempotencyResult(fullKey);
  if (replay?.resultPayload) {
    const payload = replay.resultPayload as Record<string, unknown>;
    return {
      factId: typeof payload.factId === "string" ? payload.factId : "",
      replan: (payload.replan as { runId: string; queuedAt: Date } | null) ?? null,
    };
  }

  return db.transaction(async (tx) => {
    const claim = await claimIdempotency(tx, { key: fullKey, entityType: "trip_constraint_fact" });
    if (!claim) {
      const again = await loadIdempotencyResult(fullKey);
      if (again?.resultPayload) {
        const payload = again.resultPayload as Record<string, unknown>;
        return {
          factId: typeof payload.factId === "string" ? payload.factId : "",
          replan: (payload.replan as { runId: string; queuedAt: Date } | null) ?? null,
        };
      }
      throw new ConstraintProposalServiceError(
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency record missing result payload",
      );
    }

    await requireTripExists(tx, params.tripId);
    await requireOwnerMembership(tx, params.tripId, params.ownerUserId);

    const [latestFact] = await tx.select().from(tripConstraintFacts)
      .where(and(
        eq(tripConstraintFacts.id, params.factId),
        eq(tripConstraintFacts.tripId, params.tripId),
        eq(tripConstraintFacts.ownerUserId, params.ownerUserId),
        eq(tripConstraintFacts.status, "ACTIVE"),
      ))
      .for("update")
      .limit(1);

    if (!latestFact || latestFact.fieldKey !== params.fieldKey) {
      throw new ConstraintProposalServiceError("PROPOSAL_NOT_FOUND", "Active fact does not match this update");
    }
    if (params.expectedRevision !== undefined && latestFact.revision !== params.expectedRevision) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        `Expected revision ${params.expectedRevision} but found ${latestFact?.revision ?? "none"}; reload and retry`,
      );
    }

    if (latestFact) {
      await tx.update(tripConstraintFacts)
        .set({ status: "SUPERSEDED", supersededAt: new Date() })
        .where(eq(tripConstraintFacts.id, latestFact.id));
    }

    const nextRevision = (latestFact?.revision ?? 0) + 1;
    const valueHash = hashValue(params.valueJson);
    const [fact] = await tx.insert(tripConstraintFacts).values({
      tripId: params.tripId,
      ownerUserId: params.ownerUserId,
      fieldKey: params.fieldKey,
      valueJson: params.valueJson as Record<string, unknown>,
      valueHash,
      strength: params.strength,
      visibility: params.visibility,
      revision: nextRevision,
      status: "ACTIVE",
    }).returning();

    await stalePlansAndConfirmationsForTrip(tx, {
      tripId: params.tripId,
      reason: `trip_constraint_upsert:${params.fieldKey}:${params.visibility}`,
    });

    await recordAudit({
      ctx: params.ctx,
      action: "TRIP_CONSTRAINT_CONFIRMED",
      actorUserId: params.ownerUserId,
      tripId: params.tripId,
      summary: {
        factId: fact.id,
        revision: nextRevision,
        fieldCategory: params.fieldKey,
        visibility: params.visibility,
        strength: params.strength,
        source: "OWNER_FORM",
      },
      tx,
    });

    const replan = await enqueueReplanForConstraintMutation({
      tx, ctx: params.ctx, tripId: params.tripId, userId: params.ownerUserId,
      requestId: requestKey, trigger: "trip_constraint_upsert",
    });

    await completeIdempotency(tx, fullKey, "trip_constraint_fact", fact.id, { factId: fact.id, replan });
    metrics.inc("trip_constraint_mutation_total", {
      operation: "upsert",
      visibility: visibilityLabel(params.visibility),
      strength: strengthLabel(params.strength),
      result: "success",
    });
    metrics.inc("plan_replan_total", {
      trigger: "trip_constraint_upsert",
      result: "enqueued",
    });
    return { factId: fact.id, replan };
  });
}

/**
 * Read APIs. All read paths are gated by `requireOwnerMembership`.
 * Confidential values are NEVER returned to non-owner callers.
 */
export async function listProposalsForOwner(params: {
  tripId: string;
  ownerUserId: string;
}): Promise<{ id: string; fieldKey: string; status: "PENDING" | "CONFIRMED" | "DISMISSED" | "REVOKED"; createdAt: Date; resolvedAt: Date | null }[]> {
  await db.transaction(async (tx) => {
    await requireOwnerMembership(tx, params.tripId, params.ownerUserId);
  });
  const rows = await db.select({
    id: tripConstraintProposals.id,
    fieldKey: tripConstraintProposals.fieldKey,
    status: tripConstraintProposals.status,
    createdAt: tripConstraintProposals.createdAt,
    resolvedAt: tripConstraintProposals.resolvedAt,
  }).from(tripConstraintProposals).where(and(
    eq(tripConstraintProposals.tripId, params.tripId),
    eq(tripConstraintProposals.ownerUserId, params.ownerUserId),
  ));
  return rows;
}

export async function listFactsForMembers(params: {
  tripId: string;
  viewerUserId: string;
}): Promise<{
  fieldKey: string;
  ownerUserId: string;
  strength: ConstraintStrength;
  visibility: ConstraintVisibility;
  revision: number;
  valueJson: unknown;
}[]> {
  await db.transaction(async (tx) => {
    await requireOwnerMembership(tx, params.tripId, params.viewerUserId);
  });
  const rows = await db.select({
    fieldKey: tripConstraintFacts.fieldKey,
    ownerUserId: tripConstraintFacts.ownerUserId,
    strength: tripConstraintFacts.strength,
    visibility: tripConstraintFacts.visibility,
    revision: tripConstraintFacts.revision,
    valueJson: tripConstraintFacts.valueJson,
  }).from(tripConstraintFacts).where(and(
    eq(tripConstraintFacts.tripId, params.tripId),
    eq(tripConstraintFacts.status, "ACTIVE"),
    eq(tripConstraintFacts.visibility, "TEAM_VISIBLE"),
  ));
  return rows;
}

export async function listFactsForOwner(params: {
  tripId: string;
  ownerUserId: string;
}): Promise<{
  fieldKey: string;
  visibility: ConstraintVisibility;
  strength: ConstraintStrength;
  revision: number;
  valueJson: unknown;
  createdAt: Date;
}[]> {
  await db.transaction(async (tx) => {
    await requireOwnerMembership(tx, params.tripId, params.ownerUserId);
  });
  const rows = await db.select({
    fieldKey: tripConstraintFacts.fieldKey,
    visibility: tripConstraintFacts.visibility,
    strength: tripConstraintFacts.strength,
    revision: tripConstraintFacts.revision,
    valueJson: tripConstraintFacts.valueJson,
    createdAt: tripConstraintFacts.createdAt,
  }).from(tripConstraintFacts).where(and(
    eq(tripConstraintFacts.tripId, params.tripId),
    eq(tripConstraintFacts.ownerUserId, params.ownerUserId),
    eq(tripConstraintFacts.status, "ACTIVE"),
  ));
  return rows;
}

/**
 * Member conversation handoff — batch confirm
 * (docs/member-conversation-handoff-implementation.md §5.2)
 *
 * 任一当前 active Trip member 在自己的私有 thread 看到 candidate card 后，
 * 一次性勾选若干条并提交。服务端做以下事，全部在同一个 DB 事务里：
 *   1. FOR UPDATE 锁 Trip、该 batch 全部 proposals、相关 ACTIVE facts。
 *   2. FOR UPDATE 锁 chat_threads(origin_thread_id)，验证 actor = thread owner、
 *      thread.trip_id = 本 trip。
 *   3. 验证 candidate_version 一致；逐项校验 status=PENDING、catalog、
 *      visibility/strength、profile-derived 字段 consent。
 *   4. 对选中项：写 ACTIVE fact (revision+1，旧 ACTIVE → SUPERSEDED)、
 *      proposal → CONFIRMED；未选中项保持 PENDING。
 *   5. 若存在 ACTIVE/PROPOSED plan/confirmations/votes，调
 *      stalePlansAndConfirmationsForTrip。
 *   6. 创建 immutable constraint_snapshot。
 *   7. 接受 PLAN（无当前 plan）或 REPLAN（有当前 plan）durable task。
 *   8. value-free audit + outbox + metrics。
 *
 * 同 requestId 重复提交由 `idempotencyKeyFor("handoff_confirm", ...)` 守护；
 * 并发与 race 由事务 + lease guard + snapshot manifest guard 拦截。
 */
export async function confirmConstraintHandoffBatch(params: {
  ctx: RequestContext;
  tripId: string;
  batchId: string;
  actorUserId: string;
  requestId: string;
  candidateVersion: number;
  selections: Array<{
    proposalId: string;
    visibility: ConstraintVisibility;
    strength: ConstraintStrength;
  }>;
  idempotencyKey: string;
}): Promise<{
  runId: string;
  snapshotId: string;
  operation: "PLAN" | "REPLAN";
}> {
  const requestKey = ensureRequestKey(params.idempotencyKey);
  const fullKey = `trip_constraint_handoff:handoff_confirm:${params.tripId}:${params.actorUserId}:${requestKey}`;

  const replay = await loadIdempotencyResult(fullKey);
  if (replay?.resultPayload) {
    const payload = replay.resultPayload as Record<string, unknown>;
    if (
      typeof payload.runId === "string"
      && typeof payload.snapshotId === "string"
      && (payload.operation === "PLAN" || payload.operation === "REPLAN")
    ) {
      return { runId: payload.runId, snapshotId: payload.snapshotId, operation: payload.operation };
    }
  }

  return db.transaction(async (tx) => {
    const claim = await claimIdempotency(tx, { key: fullKey, entityType: "trip_constraint_handoff" });
    if (!claim) {
      const again = await loadIdempotencyResult(fullKey);
      if (again?.resultPayload) {
        const payload = again.resultPayload as Record<string, unknown>;
        if (
          typeof payload.runId === "string"
          && typeof payload.snapshotId === "string"
          && (payload.operation === "PLAN" || payload.operation === "REPLAN")
        ) {
          return { runId: payload.runId, snapshotId: payload.snapshotId, operation: payload.operation };
        }
      }
      throw new ConstraintProposalServiceError(
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency record missing result payload — concurrent caller is in flight",
      );
    }

    // 1. Lock Trip; verify it is plannable; lock the batch's proposals.
    const [trip] = await tx.select().from(sharedTrips)
      .where(eq(sharedTrips.id, params.tripId))
      .for("update")
      .limit(1);
    if (!trip) {
      throw new ConstraintProposalServiceError("TRIP_NOT_FOUND", `Trip ${params.tripId} not found`);
    }

    // 2. Actor must be an active member of this trip (was: owner-only).
    const [actorMembership] = await tx.select({ userId: tripMembers.userId })
      .from(tripMembers)
      .where(and(
        eq(tripMembers.tripId, params.tripId),
        eq(tripMembers.userId, params.actorUserId),
      ))
      .limit(1);
    if (!actorMembership) {
      throw new ConstraintProposalServiceError(
        "FORBIDDEN",
        "Caller must be an active member of the trip",
      );
    }

    // 3. Lock the batch proposals; verify they share trip + actor + batchId.
    const proposals = await tx.select().from(tripConstraintProposals)
      .where(and(
        eq(tripConstraintProposals.tripId, params.tripId),
        eq(tripConstraintProposals.batchId, params.batchId),
      ))
      .for("update");
    if (proposals.length === 0) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        `Batch ${params.batchId} not found on trip ${params.tripId}`,
      );
    }
    if (proposals.some((p) => p.ownerUserId !== params.actorUserId)) {
      // Actor is not the candidate owner → cross-member fail closed.
      throw new ConstraintProposalServiceError(
        "FORBIDDEN",
        "Some candidates in this batch are not owned by the caller",
      );
    }
    if (proposals.some((p) => p.candidateVersion !== params.candidateVersion)) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        `Candidate version ${params.candidateVersion} does not match the persisted batch`,
      );
    }
    if (proposals.some((p) => p.status !== "PENDING")) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_PENDING",
        "One or more candidates in this batch are already resolved",
      );
    }
    if (proposals.some((p) => p.sourceKind !== "PERSONAL_AGENT")) {
      // OWNER_FORM proposals do not travel through the batch flow.
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        "This batch contains non-PERSONAL_AGENT candidates",
      );
    }

    // 4. Lock the chat_threads row referenced by the batch and verify the
    //    ownership + trip invariant that "actor == thread owner == candidate
    //    owner" holds. DB CHECK covers the row; we re-verify in code so the
    //    rejection is a clean 403/409, not a constraint violation.
    const originThreadIds = Array.from(new Set(proposals.map((p) => p.originThreadId).filter((id): id is string => Boolean(id))));
    if (originThreadIds.length === 0) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        "Candidates in this batch are missing origin_thread_id",
      );
    }
    if (originThreadIds.length > 1) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        "Batch spans more than one origin thread",
      );
    }
    const [originThread] = await tx.select().from(chatThreads)
      .where(eq(chatThreads.id, originThreadIds[0]))
      .for("update")
      .limit(1);
    if (!originThread) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        "Origin thread no longer exists",
      );
    }
    if (originThread.ownerUserId !== params.actorUserId) {
      throw new ConstraintProposalServiceError(
        "FORBIDDEN",
        "Origin thread is not owned by the caller",
      );
    }
    if (originThread.tripId !== params.tripId) {
      throw new ConstraintProposalServiceError(
        "FORBIDDEN",
        "Origin thread is bound to a different trip",
      );
    }

    // 5. Validate each selection against the catalog + consent + visibility.
    if (params.selections.length === 0) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        "At least one candidate must be selected for handoff confirmation",
      );
    }
    const selectedIds = new Set(params.selections.map((s) => s.proposalId));
    if (selectedIds.size !== params.selections.length) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        "Duplicate proposalId in selections",
      );
    }
    const matchedSelections = params.selections.filter((s) =>
      proposals.some((p) => p.id === s.proposalId),
    );
    if (matchedSelections.length !== params.selections.length) {
      throw new ConstraintProposalServiceError(
        "PROPOSAL_NOT_FOUND",
        "One or more selections refer to a proposal outside this batch",
      );
    }
    const selectedProposals = proposals.filter((p) => selectedIds.has(p.id));

    for (const proposal of selectedProposals) {
      const selection = params.selections.find((s) => s.proposalId === proposal.id)!;
      try {
        parseConstraintField({
          fieldKey: proposal.fieldKey,
          value: proposal.valueJson,
          visibility: selection.visibility,
          strength: selection.strength,
        });
      } catch {
        throw new ConstraintProposalServiceError(
          "VALUE_INVALID",
          `Catalog rejected candidate "${proposal.id}" for field "${proposal.fieldKey}"`,
        );
      }
      await requireFieldConsent(tx, {
        tripId: params.tripId,
        userId: params.actorUserId,
        fieldKey: proposal.fieldKey,
        sourceKind: proposal.sourceKind,
      });
    }

    // 6. Write ACTIVE fact (revision+1) for each selection; supersede old
    //    ACTIVE rows; mark proposals CONFIRMED.
    const writtenFactIds: string[] = [];
    for (const proposal of selectedProposals) {
      const selection = params.selections.find((s) => s.proposalId === proposal.id)!;
      const [latestFact] = await tx.select({ revision: tripConstraintFacts.revision })
        .from(tripConstraintFacts)
        .where(and(
          eq(tripConstraintFacts.tripId, params.tripId),
          eq(tripConstraintFacts.ownerUserId, params.actorUserId),
          eq(tripConstraintFacts.fieldKey, proposal.fieldKey),
          eq(tripConstraintFacts.status, "ACTIVE"),
        ))
        .orderBy(sql`${tripConstraintFacts.revision} DESC`)
        .limit(1);
      const nextRevision = (latestFact?.revision ?? 0) + 1;
      if (latestFact) {
        await tx.update(tripConstraintFacts)
          .set({ status: "SUPERSEDED", supersededAt: new Date() })
          .where(and(
            eq(tripConstraintFacts.tripId, params.tripId),
            eq(tripConstraintFacts.ownerUserId, params.actorUserId),
            eq(tripConstraintFacts.fieldKey, proposal.fieldKey),
            eq(tripConstraintFacts.status, "ACTIVE"),
          ));
      }
      const valueHash = hashValue(proposal.valueJson);
      const [fact] = await tx.insert(tripConstraintFacts).values({
        tripId: params.tripId,
        ownerUserId: params.actorUserId,
        fieldKey: proposal.fieldKey,
        valueJson: proposal.valueJson as Record<string, unknown>,
        valueHash,
        strength: selection.strength,
        visibility: selection.visibility,
        revision: nextRevision,
        sourceProposalId: proposal.id,
        status: "ACTIVE",
      }).returning({ id: tripConstraintFacts.id });
      writtenFactIds.push(fact.id);
    }

    if (selectedProposals.length > 0) {
      await tx.update(tripConstraintProposals)
        .set({ status: "CONFIRMED", resolvedAt: new Date() })
        .where(and(
          eq(tripConstraintProposals.batchId, params.batchId),
          inArray(tripConstraintProposals.id, selectedProposals.map((p) => p.id)),
          eq(tripConstraintProposals.status, "PENDING"),
        ));
    }

    // 7. Stale cascade: any ACTIVE/PROPOSED plan, confirmation, vote is now
    //    referencing stale facts. We must supersede them before we accept
    //    the new plan/replan so the durable task starts from a clean slate.
    const [existingPlan] = await tx.select({ id: itineraryPlans.id, status: itineraryPlans.status })
      .from(itineraryPlans)
      .where(and(
        eq(itineraryPlans.tripId, params.tripId),
        inArray(itineraryPlans.status, ["PROPOSED", "ACTIVE", "STALE"]),
      ))
      .orderBy(desc(itineraryPlans.version))
      .limit(1);
    const operation: "PLAN" | "REPLAN" = existingPlan ? "REPLAN" : "PLAN";

    if (existingPlan) {
      await stalePlansAndConfirmationsForTrip(tx, {
        tripId: params.tripId,
        reason: `trip_constraint_handoff_confirmed:${params.batchId}`,
      });
    }

    // 8. Create the immutable snapshot (re-uses the existing builder).
    const requiredMembers = await tx.select({ userId: tripMembers.userId })
      .from(tripMembers)
      .where(and(eq(tripMembers.tripId, params.tripId), eq(tripMembers.isRequired, true)));
    if (requiredMembers.length === 0) {
      throw new ConstraintProposalServiceError(
        "FORBIDDEN",
        "A replan requires at least one required trip member",
      );
    }
    const [preference] = await tx.select({ version: tripSearchPreferences.version })
      .from(tripSearchPreferences)
      .where(eq(tripSearchPreferences.tripId, params.tripId))
      .orderBy(desc(tripSearchPreferences.version))
      .limit(1);
    if (!preference) {
      throw new ConstraintProposalServiceError(
        "FORBIDDEN",
        "Confirmed flight search preferences are required before changing shared constraints",
      );
    }
    const [stayPreference] = process.env.PLAN_ENABLE_HOTEL === "true"
      ? await tx.select({ version: tripStaySearchPreferences.version }).from(tripStaySearchPreferences)
        .where(eq(tripStaySearchPreferences.tripId, params.tripId)).orderBy(desc(tripStaySearchPreferences.version)).limit(1)
      : [];
    if (process.env.PLAN_ENABLE_HOTEL === "true" && !stayPreference) {
      throw new ConstraintProposalServiceError(
        "FORBIDDEN",
        "Confirmed stay search preferences are required before changing shared constraints",
      );
    }

    const snapshotId = await createConstraintSnapshot({
      tripId: params.tripId,
      memberIds: requiredMembers.map((m) => m.userId),
      departureCities: trip.departureCities as string[],
      destinationCandidates: trip.destinationCandidates as string[],
      travelDateStart: trip.travelDateStart ?? undefined,
      travelDateEnd: trip.travelDateEnd ?? undefined,
      tx,
    });

    // 9. Accept the durable plan/replan task in the same transaction.
    const accepted = await acceptPlanningTask({
      ctx: params.ctx,
      tripId: params.tripId,
      userId: params.actorUserId,
      snapshotId,
      flightSearchPreferencesVersion: preference.version,
      staySearchPreferencesVersion: stayPreference?.version,
      operation,
      requestId: stableUuidFromRequestKey(params.requestId),
      tx,
    });

    // 10. Value-free audit + metrics.
    await recordAudit({
      ctx: params.ctx,
      action: "MEMBER_CONVERSATION_HANDOFF_CONFIRMED",
      actorUserId: params.actorUserId,
      tripId: params.tripId,
      summary: {
        batchId: params.batchId,
        candidateVersion: params.candidateVersion,
        selectionCount: params.selections.length,
        operation,
        factIds: writtenFactIds,
      },
      tx,
    });
    metrics.inc("trip_constraint_mutation_total", {
      operation: "handoff_confirm",
      visibility: "mixed",
      strength: "mixed",
      result: "success",
    });
    metrics.inc("conversation_handoff_confirm_total", { operation: operation.toLowerCase(), result: "success" });
    metrics.inc("plan_replan_total", {
      trigger: "conversation_handoff",
      result: "enqueued",
    });

    await completeIdempotency(tx, fullKey, "trip_constraint_handoff", accepted.runId, {
      runId: accepted.runId,
      snapshotId,
      operation,
    });

    return { runId: accepted.runId, snapshotId, operation };
  });
}

/**
 * Member-private batch read. Returns the batch's proposals and a list of
 * residual-inference warning tokens the UI must surface before the member
 * confirms any ORCHESTRATOR_CONFIDENTIAL selection. The caller must be the
 * candidate owner; otherwise this fails closed.
 */
export async function listConversationHandoffBatch(params: {
  tripId: string;
  batchId: string;
  actorUserId: string;
}): Promise<{
  tripId: string;
  batchId: string;
  candidateVersion: number;
  batch: Array<{
    id: string;
    fieldKey: string;
    valueJson: unknown;
    strength: ConstraintStrength;
    proposedVisibility: ConstraintVisibility;
    sourceKind: "PERSONAL_AGENT";
    status: "PENDING" | "CONFIRMED" | "DISMISSED";
    candidateVersion: number;
  }>;
  residualInferenceWarnings: string[];
}> {
  const rows = await db.select({
    id: tripConstraintProposals.id,
    ownerUserId: tripConstraintProposals.ownerUserId,
    fieldKey: tripConstraintProposals.fieldKey,
    valueJson: tripConstraintProposals.valueJson,
    strength: tripConstraintProposals.strength,
    proposedVisibility: tripConstraintProposals.proposedVisibility,
    sourceKind: tripConstraintProposals.sourceKind,
    status: tripConstraintProposals.status,
    candidateVersion: tripConstraintProposals.candidateVersion,
  }).from(tripConstraintProposals).where(and(
    eq(tripConstraintProposals.tripId, params.tripId),
    eq(tripConstraintProposals.batchId, params.batchId),
  ));
  if (rows.length === 0) {
    throw new ConstraintProposalServiceError(
      "PROPOSAL_NOT_FOUND",
      `Batch ${params.batchId} not found on trip ${params.tripId}`,
    );
  }
  if (rows.some((r) => r.ownerUserId !== params.actorUserId)) {
    throw new ConstraintProposalServiceError(
      "FORBIDDEN",
      "Batch contains candidates not owned by the caller",
    );
  }
  if (rows.some((r) => r.sourceKind !== "PERSONAL_AGENT")) {
    throw new ConstraintProposalServiceError(
      "PROPOSAL_NOT_FOUND",
      "Batch contains non-PERSONAL_AGENT candidates",
    );
  }
  const candidateVersion = rows[0].candidateVersion;
  if (rows.some((r) => r.candidateVersion !== candidateVersion)) {
    throw new ConstraintProposalServiceError(
      "PROPOSAL_NOT_FOUND",
      "Batch contains mixed candidate versions",
    );
  }

  const residualInferenceWarnings: string[] = [];
  for (const row of rows) {
    const token = requiresResidualInferenceWarning(row.fieldKey as keyof typeof CONSTRAINT_FIELD_CATALOG);
    if (token && !residualInferenceWarnings.includes(token)) residualInferenceWarnings.push(token);
  }

  return {
    tripId: params.tripId,
    batchId: params.batchId,
    candidateVersion,
    batch: rows.map((row) => ({
      id: row.id,
      fieldKey: row.fieldKey,
      valueJson: row.valueJson,
      strength: row.strength,
      proposedVisibility: row.proposedVisibility,
      sourceKind: "PERSONAL_AGENT" as const,
      // The batch lifecycle is PENDING → CONFIRMED | DISMISSED. A row that
      // somehow sits at REVOKED cannot happen at read time, but we narrow
      // here so the DTO is honest about what is exposed to the private UI.
      status: (["CONFIRMED", "PENDING", "DISMISSED"] as const).includes(
        row.status as "CONFIRMED" | "PENDING" | "DISMISSED",
      )
        ? (row.status as "CONFIRMED" | "PENDING" | "DISMISSED")
        : "PENDING",
      candidateVersion: row.candidateVersion,
    })),
    residualInferenceWarnings,
  };
}
