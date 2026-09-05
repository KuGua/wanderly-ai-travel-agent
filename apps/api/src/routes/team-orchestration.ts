import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { ApiError } from "../middleware/error-handler.js";
import { createRequestContext } from "../utils/context.js";
import { requireActiveTrip } from "../services/trip-status-guard.js";
import { db } from "../db/database.js";
import { tripMembers, tripConstraintProposals } from "../db/schema.js";
import {
  proposeConstraint,
  dismissConstraintProposal,
  confirmConstraintProposal,
  confirmConstraintHandoffBatch,
  listConversationHandoffBatch,
  revokeConstraintFact,
  upsertConstraintFactDirect,
  listFactsForMembers,
  listFactsForOwner,
  listProposalsForOwner,
  ConstraintProposalServiceError,
} from "../services/constraint-proposal-service.js";
import {
  constraintHandoffConfirmRequestSchema,
  constraintHandoffConfirmResponseSchema,
  constraintHandoffBatchResponseSchema,
  uuidSchema,
} from "../types/schemas.js";
import {
  castVote,
  getVoteSummary,
  PlanAdoptionServiceError,
} from "../services/plan-adoption-service.js";
import { listTripPlans } from "../services/plan-listing-service.js";
import {
  createTripConstraintProposalRequestSchema,
  confirmTripConstraintProposalRequestSchema,
  upsertTripConstraintFactRequestSchema,
  castAdoptionVoteRequestSchema,
  tripConstraintProposalSchema,
  tripConstraintFactSchema,
} from "../types/schemas.js";

const tripIdParamsSchema = z.object({ tripId: uuidSchema }).strict();
const proposalIdParamsSchema = z.object({ tripId: uuidSchema, proposalId: uuidSchema }).strict();
const batchIdParamsSchema = z.object({ tripId: uuidSchema, batchId: uuidSchema }).strict();
const factIdParamsSchema = z.object({ tripId: uuidSchema, factId: uuidSchema }).strict();
const planIdParamsSchema = z.object({ planId: uuidSchema }).strict();

const idempotencyHeaderSchema = z.string().uuid();

const tripConstraintProposalsListResponseSchema = z.object({
  tripId: uuidSchema,
  proposals: z.array(tripConstraintProposalSchema),
}).strict();

const tripConstraintsListResponseSchema = z.object({
  tripId: uuidSchema,
  teamVisibleFacts: z.array(tripConstraintFactSchema),
}).strict();

const tripConstraintsOwnerListResponseSchema = z.object({
  tripId: uuidSchema,
  allFacts: z.array(tripConstraintFactSchema),
}).strict();

const adoptionVoteResponseSchema = z.object({
  planId: uuidSchema,
  outcome: z.enum(["CAST", "ADOPTED", "BLOCKED"]),
  votesAccepted: z.number().int().nonnegative(),
  votesRequired: z.number().int().nonnegative(),
}).strict();

const adoptionVoteListResponseSchema = z.object({
  planId: uuidSchema,
  votesAccepted: z.number().int().nonnegative(),
  votesRequired: z.number().int().nonnegative(),
  hasBlocker: z.boolean(),
  currentUserDecision: z.enum(["ACCEPT", "NEEDS_CHANGES"]).nullable(),
}).strict();

const listedPlanSchema = z.object({
  id: uuidSchema,
  version: z.number().int().nonnegative(),
  status: z.enum(["DRAFT", "ACTIVE", "PROPOSED", "STALE", "SUPERSEDED"]),
  snapshotId: uuidSchema,
  generatedAt: z.string().datetime(),
  destination: z.string().min(0),
  destinationCandidatesEvaluated: z.array(z.string()),
  replacedByPlanId: uuidSchema.nullable(),
  staleReason: z.string().nullable(),
  planData: z.record(z.string(), z.unknown()),
}).strict();

const tripPlansListResponseSchema = z.object({
  tripId: uuidSchema,
  proposed: z.array(listedPlanSchema),
  active: z.array(listedPlanSchema),
  stale: z.array(listedPlanSchema),
}).strict();

async function assertMember(tripId: string, userId: string): Promise<void> {
  const [member] = await db.select({ id: tripMembers.id }).from(tripMembers).where(and(
    eq(tripMembers.tripId, tripId),
    eq(tripMembers.userId, userId),
  )).limit(1);
  if (!member) {
    throw new ApiError(403, "Forbidden", "Caller is not an active member of this trip");
  }
}

function buildCtx(request: import("fastify").FastifyRequest, userId: string): ReturnType<typeof createRequestContext> {
  return createRequestContext(
    userId,
    request.correlationId,
    request.traceId,
    request.clientRequestId,
    request.traceparent,
    request.tracestate,
    request.spanId,
  );
}

export async function teamOrchestrationRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /trips/:tripId/constraint-proposals ─────────────────────────────
  app.post("/trips/:tripId/constraint-proposals", async (request) => {
    const { tripId } = tripIdParamsSchema.parse(request.params);
    const ctx = buildCtx(request, request.user.id);
    const idempotencyKey = idempotencyHeaderSchema.parse(request.headers["idempotency-key"]);
    const body = createTripConstraintProposalRequestSchema.parse(request.body);
    await requireActiveTrip(tripId, "constraint_propose");
    try {
      const { proposalId } = await proposeConstraint({
        ctx, tripId, ownerUserId: request.user.id,
        envelope: {
          fieldKey: body.fieldKey,
          valueJson: body.valueJson,
          strength: body.proposedStrength,
          proposedVisibility: body.proposedVisibility,
          sourceKind: "OWNER_FORM",
        },
        idempotencyKey,
      });
      return { proposalId };
    } catch (err) {
      if (err instanceof ConstraintProposalServiceError) {
        throw new ApiError(err.statusCode, err.name, err.message);
      }
      throw err;
    }
  });

  // ─── GET /trips/:tripId/constraint-proposals/me ───────────────────────────
  app.get("/trips/:tripId/constraint-proposals/me", async (request) => {
    const { tripId } = tripIdParamsSchema.parse(request.params);
    await requireActiveTrip(tripId, "constraint_read");
    const rows = await listProposalsForOwner({ tripId, ownerUserId: request.user.id });
    return tripConstraintProposalsListResponseSchema.parse({
      tripId,
      proposals: rows,
    });
  });

  // ─── GET /trips/:tripId/constraint-proposals/:proposalId ──────────────────
  app.get("/trips/:tripId/constraint-proposals/:proposalId", async (request) => {
    const { tripId, proposalId } = proposalIdParamsSchema.parse(request.params);
    await assertMember(tripId, request.user.id);
    const [row] = await db.select().from(tripConstraintProposals).where(and(
      eq(tripConstraintProposals.id, proposalId),
      eq(tripConstraintProposals.tripId, tripId),
      eq(tripConstraintProposals.ownerUserId, request.user.id),
    )).limit(1);
    if (!row) {
      throw new ApiError(404, "Not Found", "Proposal not found");
    }
    return { proposal: tripConstraintProposalSchema.parse(row) };
  });

  // ─── POST /trips/:tripId/constraint-proposals/:proposalId/confirm ─────────
  app.post("/trips/:tripId/constraint-proposals/:proposalId/confirm", async (request) => {
    const { tripId, proposalId } = proposalIdParamsSchema.parse(request.params);
    const ctx = buildCtx(request, request.user.id);
    const idempotencyKey = idempotencyHeaderSchema.parse(request.headers["idempotency-key"]);
    const body = confirmTripConstraintProposalRequestSchema.parse(request.body);
    await requireActiveTrip(tripId, "constraint_confirm");
    try {
      const out = await confirmConstraintProposal({
        ctx, tripId, proposalId, ownerUserId: request.user.id,
        visibility: body.visibility, strength: body.strength,
        idempotencyKey,
      });
      return out;
    } catch (err) {
      if (err instanceof ConstraintProposalServiceError) {
        throw new ApiError(err.statusCode, err.name, err.message);
      }
      throw err;
    }
  });

  // ─── POST /trips/:tripId/constraint-proposals/:proposalId/dismiss ─────────
  app.post("/trips/:tripId/constraint-proposals/:proposalId/dismiss", async (request) => {
    const { tripId, proposalId } = proposalIdParamsSchema.parse(request.params);
    const ctx = buildCtx(request, request.user.id);
    const idempotencyKey = idempotencyHeaderSchema.parse(request.headers["idempotency-key"]);
    await requireActiveTrip(tripId, "constraint_dismiss");
    try {
      await dismissConstraintProposal({
        ctx, tripId, proposalId, ownerUserId: request.user.id,
        idempotencyKey,
      });
      return { dismissed: true, proposalId };
    } catch (err) {
      if (err instanceof ConstraintProposalServiceError) {
        throw new ApiError(err.statusCode, err.name, err.message);
      }
      throw err;
    }
  });

  // ─── PUT /trips/:tripId/constraints/:factId ────────────────────────────────
  app.put("/trips/:tripId/constraints/:factId", async (request) => {
    const { tripId, factId } = factIdParamsSchema.parse(request.params);
    const ctx = buildCtx(request, request.user.id);
    const idempotencyKey = idempotencyHeaderSchema.parse(request.headers["idempotency-key"]);
    const body = upsertTripConstraintFactRequestSchema.parse(request.body);
    await requireActiveTrip(tripId, "constraint_upsert");
    try {
      const out = await upsertConstraintFactDirect({
        ctx, tripId, factId, ownerUserId: request.user.id,
        fieldKey: body.fieldKey, valueJson: body.valueJson,
        visibility: body.visibility, strength: body.strength,
        expectedRevision: body.expectedRevision,
        idempotencyKey,
      });
      return out;
    } catch (err) {
      if (err instanceof ConstraintProposalServiceError) {
        throw new ApiError(err.statusCode, err.name, err.message);
      }
      throw err;
    }
  });

  // ─── DELETE /trips/:tripId/constraints/:factId ─────────────────────────────
  app.delete("/trips/:tripId/constraints/:factId", async (request) => {
    const { tripId, factId } = factIdParamsSchema.parse(request.params);
    const ctx = buildCtx(request, request.user.id);
    const idempotencyKey = idempotencyHeaderSchema.parse(request.headers["idempotency-key"]);
    await requireActiveTrip(tripId, "constraint_revoke");
    try {
      const out = await revokeConstraintFact({
        ctx, tripId, factId, ownerUserId: request.user.id,
        idempotencyKey,
      });
      return out;
    } catch (err) {
      if (err instanceof ConstraintProposalServiceError) {
        throw new ApiError(err.statusCode, err.name, err.message);
      }
      throw err;
    }
  });

  // ─── GET /trips/:tripId/constraints/me ────────────────────────────────────
  app.get("/trips/:tripId/constraints/me", async (request) => {
    const { tripId } = tripIdParamsSchema.parse(request.params);
    await requireActiveTrip(tripId, "constraint_read");
    const rows = await listFactsForOwner({ tripId, ownerUserId: request.user.id });
    return tripConstraintsOwnerListResponseSchema.parse({ tripId, allFacts: rows });
  });

  // ─── GET /trips/:tripId/constraints ──────────────────────────────────────
  app.get("/trips/:tripId/constraints", async (request) => {
    const { tripId } = tripIdParamsSchema.parse(request.params);
    await assertMember(tripId, request.user.id);
    const rows = await listFactsForMembers({ tripId, viewerUserId: request.user.id });
    return tripConstraintsListResponseSchema.parse({ tripId, teamVisibleFacts: rows });
  });

  // ─── GET /trips/:tripId/plans ────────────────────────────────────────────
  // Spec §5.2: members receive TEAM_VISIBLE plans split into proposed/active/stale
  // sections. Confidential values are stripped by `listTripPlans`.
  app.get("/trips/:tripId/plans", async (request) => {
    const { tripId } = tripIdParamsSchema.parse(request.params);
    await assertMember(tripId, request.user.id);
    const sections = await listTripPlans({ tripId, viewerUserId: request.user.id });
    return tripPlansListResponseSchema.parse({ tripId, ...sections });
  });

  // ─── POST /plans/:planId/adoption-votes ───────────────────────────────────
  app.post("/plans/:planId/adoption-votes", async (request) => {
    const { planId } = planIdParamsSchema.parse(request.params);
    const ctx = buildCtx(request, request.user.id);
    const idempotencyKey = idempotencyHeaderSchema.parse(request.headers["idempotency-key"]);
    const body = castAdoptionVoteRequestSchema.parse(request.body);
    try {
      const out = await castVote({
        ctx, planId, userId: request.user.id,
        decision: body.decision,
        idempotencyKey,
      });
      return adoptionVoteResponseSchema.parse({
        planId, outcome: out.outcome, votesAccepted: out.votesAccepted, votesRequired: out.votesRequired,
      });
    } catch (err) {
      if (err instanceof PlanAdoptionServiceError) {
        throw new ApiError(err.statusCode, err.name, err.message);
      }
      throw err;
    }
  });

  // ─── GET /plans/:planId/adoption-votes ────────────────────────────────────
  app.get("/plans/:planId/adoption-votes", async (request) => {
    const { planId } = planIdParamsSchema.parse(request.params);
    const result = await getVoteSummary({ planId, userId: request.user.id });
    return adoptionVoteListResponseSchema.parse(result);
  });

  // ─── GET /trips/:tripId/constraint-handoffs/:batchId ─────────────────────
  // Spec §5.3: member-private read of a candidate batch. Only the candidate
  // owner (i.e. the caller) may read it; cross-user / cross-trip / missing
  // batch all return 403/404.
  app.get("/trips/:tripId/constraint-handoffs/:batchId", async (request) => {
    const { tripId, batchId } = batchIdParamsSchema.parse(request.params);
    await requireActiveTrip(tripId, "constraint_read");
    try {
      const out = await listConversationHandoffBatch({
        tripId,
        batchId,
        actorUserId: request.user.id,
      });
      return constraintHandoffBatchResponseSchema.parse(out);
    } catch (err) {
      if (err instanceof ConstraintProposalServiceError) {
        throw new ApiError(err.statusCode, err.name, err.message);
      }
      throw err;
    }
  });

  // ─── POST /trips/:tripId/constraint-handoffs/:batchId/confirm ────────────
  // Spec §5.2: atomic batch confirm. The service handles the
  // FOR UPDATE + triple-equality + catalog + consent + stale + snapshot +
  // PLAN/REPLAN accept transaction. The route only validates the input
  // shape and surfaces typed errors.
  app.post("/trips/:tripId/constraint-handoffs/:batchId/confirm", async (request) => {
    const { tripId, batchId } = batchIdParamsSchema.parse(request.params);
    const ctx = buildCtx(request, request.user.id);
    const idempotencyKey = idempotencyHeaderSchema.parse(request.headers["idempotency-key"]);
    const body = constraintHandoffConfirmRequestSchema.parse(request.body);
    await requireActiveTrip(tripId, "constraint_confirm");
    try {
      const out = await confirmConstraintHandoffBatch({
        ctx,
        tripId,
        batchId,
        actorUserId: request.user.id,
        requestId: body.requestId,
        candidateVersion: body.candidateVersion,
        selections: body.selections,
        idempotencyKey,
      });
      // Strict contract enforcement on the wire — the service already
      // returns the DTO shape, but re-parsing here means any drift (a new
      // field added server-side, an old field accidentally removed) is
      // surfaced immediately rather than as a runtime mismatch the next
      // time a Phase-2 client expects `{ runId, operation }`.
      return constraintHandoffConfirmResponseSchema.parse(out);
    } catch (err) {
      if (err instanceof ConstraintProposalServiceError) {
        throw new ApiError(err.statusCode, err.name, err.message);
      }
      throw err;
    }
  });
}
