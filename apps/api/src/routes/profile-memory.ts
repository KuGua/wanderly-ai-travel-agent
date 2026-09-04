import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/database.js";
import { preferenceFacts, tripMembers } from "../db/schema.js";
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
import { userProfiles } from "../db/schema.js";
import { rememberHighlight } from "../services/memory-highlight-service.js";
import {
  FREE_TEXT_MEMORY_MAX_CHARS,
  archiveFreeTextMemory,
  deleteFreeTextMemory,
  listFreeTextMemories,
  personalNoteCategoryValues,
  saveFreeTextMemory,
} from "../services/free-text-memory-service.js";

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

  // ─── POST /profiles/me/memory/highlights ─────────────────────────────────
  // A sentence the traveller highlighted. Kept as a catalogue field when it
  // says something the schema models, and as their own words when it does
  // not — see `memory-highlight-service.ts` for why both exist.
  app.post("/profiles/me/memory/highlights", async (request, reply) => {
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const body = z.object({
      // Bounded here as well as in the service: the body cap keeps a
      // megabyte of pasted text from reaching a model call at all.
      highlight: z.string().trim().min(1).max(4000),
      sourceThreadId: z.string().uuid().nullable().optional(),
      sourceMessageId: z.string().uuid().nullable().optional(),
    }).strict().parse(request.body);

    const [profile] = await db.select({ id: userProfiles.id }).from(userProfiles)
      .where(eq(userProfiles.userId, request.user.id)).limit(1);
    if (!profile) throw new ApiError(404, "Not Found", "Profile not found");

    const result = await rememberHighlight({
      ctx,
      userId: request.user.id,
      profileId: profile.id,
      highlight: body.highlight,
      sourceThreadId: body.sourceThreadId ?? null,
      sourceMessageId: body.sourceMessageId ?? null,
    });
    // A refusal is a normal answer the UI shows the traveller, not an error.
    return reply.code(result.outcome === "REMEMBERED_NOTE" ? 201 : 200)
      .send({ ...result, highlightMaxChars: FREE_TEXT_MEMORY_MAX_CHARS });
  });

  // ─── GET /profiles/me/memory/notes ───────────────────────────────────────
  app.get("/profiles/me/memory/notes", async (request) => {
    const notes = await listFreeTextMemories(request.user.id);
    return {
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        content: note.content,
        category: note.category,
        appliesTo: note.appliesTo,
        tripId: note.tripId,
        priority: note.priority,
        status: note.status,
        createdAt: note.createdAt.toISOString(),
      })),
    };
  });

  // Profile form's explicit Personal Note write path. It is intentionally
  // separate from a chat highlight and cannot create a structured fact.
  app.post("/profiles/me/memory/notes", async (request, reply) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = z.object({
      title: z.string().trim().min(1).max(80),
      content: z.string().trim().min(1).max(FREE_TEXT_MEMORY_MAX_CHARS),
      category: z.enum(personalNoteCategoryValues).default("GENERAL"),
      appliesTo: z.enum(["ALL_TRIPS", "CURRENT_TRIP"]).default("ALL_TRIPS"),
      tripId: z.string().uuid().nullable().optional(),
      priority: z.enum(["PINNED", "NORMAL"]).default("NORMAL"),
    }).strict().parse(request.body);
    if (body.appliesTo === "CURRENT_TRIP") {
      const [membership] = await db.select({ tripId: tripMembers.tripId }).from(tripMembers).where(and(
        eq(tripMembers.tripId, body.tripId ?? ""),
        eq(tripMembers.userId, request.user.id),
      )).limit(1);
      if (!membership) throw new ApiError(403, "Forbidden", "You are not an active member of this trip");
    }
    const result = await saveFreeTextMemory({
      ctx, userId: request.user.id, title: body.title, content: body.content,
      category: body.category, appliesTo: body.appliesTo, tripId: body.tripId ?? null, priority: body.priority,
    });
    if (result.outcome !== "SAVED") return reply.code(422).send(result);
    return reply.code(201).send({ note: result.memory, remaining: result.remaining });
  });

  app.post<{ Params: { noteId: string } }>("/profiles/me/memory/notes/:noteId/archive", async (request, reply) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.params);
    if (!await archiveFreeTextMemory({ ctx, userId: request.user.id, memoryId: noteId })) {
      throw new ApiError(404, "Not Found", "Note not found");
    }
    return reply.code(204).send();
  });

  // ─── DELETE /profiles/me/memory/notes/:noteId ────────────────────────────
  app.delete<{ Params: { noteId: string } }>("/profiles/me/memory/notes/:noteId", async (request, reply) => {
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const { noteId } = z.object({ noteId: z.string().uuid() }).parse(request.params);
    const deleted = await deleteFreeTextMemory({ ctx, userId: request.user.id, memoryId: noteId });
    if (!deleted) throw new ApiError(404, "Not Found", "Note not found");
    return reply.code(204).send();
  });
}
