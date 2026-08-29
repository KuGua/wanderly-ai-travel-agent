import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/database.js";
import { preferenceFacts } from "../db/schema.js";
import { withMemoryIdempotency } from "./memory-idempotency.js";
import { ApiError } from "../middleware/error-handler.js";
import { createRequestContext } from "../utils/context.js";
import { metrics } from "../observability/metrics.js";
import {
  MemoryFieldRejectedError,
  deleteFact,
  listActiveFacts,
  replaceFact,
} from "../services/preference-fact-service.js";
import {
  clearPendingProposalsForField,
  confirmProposal,
  deleteProposalsForField,
  dismissProposal,
  listSurfaceableProposals,
} from "../services/memory-proposal-service.js";
import { memoryFieldDefinition } from "../memory/memory-field-catalog.js";

/**
 * Personal long-term memory API (docs/long-term-memory-implementation.md §5.3).
 *
 * Every route is owner-only. The owner is taken from the authenticated
 * identity; no request body may carry a `userId`, so a caller cannot address
 * another person's memory.
 *
 * Responses deliberately exclude `profileId`, behavioural evidence references,
 * observation dates, activation and raw chat — see §5.4.
 */

const putValueSchema = z.object({ value: z.unknown() }).strict();

/** Maps a catalogue rejection onto the shared error envelope. */
function rejectionToApiError(error: MemoryFieldRejectedError): ApiError {
  switch (error.reason) {
    case "UNREGISTERED_FIELD":
      return new ApiError(404, "Not Found", "Unknown memory field");
    case "SENSITIVE_FIELD":
      // Deliberately not 404: the field exists, but this path may never write
      // it. Saying so is safe — the catalogue is not secret.
      return new ApiError(403, "Forbidden", "This field can only be set from the Profile form");
    default:
      return new ApiError(422, "Validation Error", "Value does not match the field schema");
  }
}

export async function profileMemoryRoutes(app: FastifyInstance) {
  /** Active facts plus the suggestions that have cleared the trigger rule. */
  app.get("/profiles/me/memory", async (request) => {
    const [facts, suggestions] = await Promise.all([
      listActiveFacts(request.user.id),
      listSurfaceableProposals(request.user.id),
    ]);

    return {
      facts: facts
        // Skip keys the catalogue no longer vouches for rather than emitting them.
        .filter((fact) => memoryFieldDefinition(fact.fieldKey) !== null)
        .map((fact) => ({
          id: fact.id,
          fieldKey: fact.fieldKey,
          value: fact.value,
          category: fact.category,
          source: fact.source,
          status: fact.status,
          updatedAt: fact.updatedAt.toISOString(),
        })),
      // Aggregate evidence only: no dates, trips, activation or score (§5.4).
      suggestions: suggestions.map((proposal) => ({
        id: proposal.id,
        fieldKey: proposal.fieldKey,
        value: proposal.proposedValue,
        observationCount: proposal.observationCount,
        distinctTripCount: proposal.distinctTripCount,
        expiresAt: proposal.expiresAt.toISOString(),
      })),
    };
  });

  /**
   * Replaces one non-sensitive stable fact.
   *
   * Stating a value directly also clears any pending suggestion for that
   * field: evidence gathered against the old value is no longer a question
   * worth asking (§5.8).
   */
  app.put<{ Params: { factId: string } }>("/profiles/me/memory/facts/:factId", async (request) => {
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const { value } = putValueSchema.parse(request.body);

    const [existing] = await db.select().from(preferenceFacts)
      .where(and(
        eq(preferenceFacts.id, request.params.factId),
        eq(preferenceFacts.userId, request.user.id),
      ));
    if (!existing) throw new ApiError(404, "Not Found", "Fact not found");

    try {
      return await withMemoryIdempotency({
        request,
        userId: request.user.id,
        operation: "fact.replace",
        entityType: "memory_fact",
        entityId: (result) => result.id,
      }, async () => {
      const fact = await db.transaction(async (tx) => {
        const replaced = await replaceFact({
          ctx,
          userId: request.user.id,
          profileId: existing.profileId,
          fieldKey: existing.fieldKey,
          value,
          path: "PROFILE_FORM",
          tx,
        });
        await clearPendingProposalsForField({
          userId: request.user.id,
          fieldKey: existing.fieldKey,
          tx,
        });
        return replaced;
      });

      return {
        id: fact.id,
        fieldKey: fact.fieldKey,
        value: fact.value,
        category: fact.category,
        source: fact.source,
        status: fact.status,
        updatedAt: fact.updatedAt.toISOString(),
      };
      });
    } catch (error) {
      if (error instanceof MemoryFieldRejectedError) throw rejectionToApiError(error);
      throw error;
    }
  });

  /** Deletes a fact and every trace of that field's memory for this owner. */
  app.delete<{ Params: { factId: string } }>("/profiles/me/memory/facts/:factId", async (request, reply) => {
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );

    const [existing] = await db.select().from(preferenceFacts)
      .where(and(
        eq(preferenceFacts.id, request.params.factId),
        eq(preferenceFacts.userId, request.user.id),
      ));
    if (!existing) throw new ApiError(404, "Not Found", "Fact not found");

    await db.transaction(async (tx) => {
      await deleteFact({ ctx, userId: request.user.id, factId: request.params.factId, tx });
      // Removing the fact must take the candidate evidence with it, or the
      // suggestion would immediately reappear from data the user just deleted.
      await deleteProposalsForField({ userId: request.user.id, fieldKey: existing.fieldKey, tx });
    });

    return reply.code(204).send();
  });

  /** Confirms a suggestion, creating the fact. Idempotent on terminal states. */
  app.post<{ Params: { proposalId: string } }>(
    "/profiles/me/memory/proposals/:proposalId/confirm",
    async (request) => {
      const ctx = createRequestContext(
        request.user.id, request.correlationId, request.traceId,
        request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
      );

      const result = await confirmProposal({
        ctx, userId: request.user.id, proposalId: request.params.proposalId,
      });

      if (result.outcome === "NOT_FOUND") {
        metrics.inc("memory_proposal_resolutions_total", { outcome: "not_found" });
        throw new ApiError(404, "Not Found", "Proposal not found");
      }
      if (result.outcome === "ALREADY_RESOLVED") {
        metrics.inc("memory_proposal_resolutions_total", { outcome: "already_resolved" });
        return { status: result.proposal.status, factId: null };
      }
      if (result.outcome === "EXPIRED") {
        // Not an error the caller can fix by retrying: the suggestion lapsed
        // before it was answered, and no fact is created.
        metrics.inc("memory_proposal_resolutions_total", { outcome: "expired" });
        return { status: result.proposal.status, factId: null };
      }
      if (result.outcome !== "CONFIRMED") throw new ApiError(500, "Internal Server Error", "Unexpected outcome");

      metrics.inc("memory_proposal_resolutions_total", { outcome: "confirmed" });
      return { status: result.proposal.status, factId: result.fact.id };
    },
  );

  /** Dismisses a suggestion and suppresses it for the cooldown window. */
  app.post<{ Params: { proposalId: string } }>(
    "/profiles/me/memory/proposals/:proposalId/dismiss",
    async (request) => {
      const ctx = createRequestContext(
        request.user.id, request.correlationId, request.traceId,
        request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
      );

      const result = await dismissProposal({
        ctx, userId: request.user.id, proposalId: request.params.proposalId,
      });

      if (result.outcome === "NOT_FOUND") {
        metrics.inc("memory_proposal_resolutions_total", { outcome: "not_found" });
        throw new ApiError(404, "Not Found", "Proposal not found");
      }
      if (result.outcome === "ALREADY_RESOLVED") {
        metrics.inc("memory_proposal_resolutions_total", { outcome: "already_resolved" });
        return { status: result.proposal.status };
      }

      metrics.inc("memory_proposal_resolutions_total", { outcome: "dismissed" });
      return { status: result.proposal.status };
    },
  );
}
