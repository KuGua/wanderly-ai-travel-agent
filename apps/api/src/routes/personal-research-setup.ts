/**
 * Personal Research Setup Sessions — owner-only routes.
 *
 * `GET    /api/v1/agent-runs/:runId/research-setup`          — read open session
 * `POST   /api/v1/agent-runs/:runId/research-setup/answers`  — apply one patch
 * `POST   /api/v1/agent-runs/:runId/research-setup/cancel`   — mark CANCELLED
 * `POST   /api/v1/agent-runs/:runId/research-setup/confirm-and-search`
 *       — atomic confirm: re-validate → write trip/preferences → stale cascade
 *         → audit → transition intent → accept RESEARCH task → publish SNAPSHOT_CREATED
 *
 * Every route:
 *   * Authenticates the caller via the standard request user context.
 *   * Enforces ownership via `getAuthorizedAgentRun` so a non-owner 403s
 *     before any setup-row read or write fires.
 *   * Passes through to the service layer in
 *     `personal-research-setup-service.ts`, which owns the transaction
 *     shape, the optimistic-version gate, and the audit / SSE wiring.
 *
 * Source: docs/personal-research-intent-routing-implementation.md §9.
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { db } from "../db/database.js";
import { agentTaskRuns } from "../db/schema.js";
import { ApiError } from "../middleware/error-handler.js";
import {
  confirmAndSearch,
  applyAnswer,
  cancelSession,
  getOrOpenSession,
  loadSessionForOwner,
} from "../services/personal-research-setup-service.js";
import { getAuthorizedAgentRun } from "../tasks/task-repository.js";
import {
  errorResponseSchema,
  personalResearchSetupApplyRequestSchema,
  personalResearchSetupConfirmAcceptedResponseSchema,
  personalResearchSetupConfirmRequestSchema,
  personalResearchSetupSessionEnvelopeSchema,
  toJsonSchema,
  uuidSchema,
} from "../types/schemas.js";
import { createRequestContext } from "../utils/context.js";

const runIdParamsSchema = z.object({ runId: uuidSchema }).strict();

async function loadRunTripId(runId: string, userId: string): Promise<string> {
  // The owner DTO from `getAuthorizedAgentRun` does not include `tripId`
  // (it is server-internal). For the routes that need to commit a confirm
  // we re-load the bare column under the same owner / member scope the
  // DTO enforces; cross-user 403s are unreachable from this path.
  await getAuthorizedAgentRun(runId, userId);
  const [row] = await db.select({ tripId: agentTaskRuns.tripId }).from(agentTaskRuns)
    .where(eq(agentTaskRuns.id, runId)).limit(1);
  if (!row?.tripId) {
    throw new ApiError(409, "Conflict", "Conversation run is missing a trip binding");
  }
  return row.tripId;
}

export async function personalResearchSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/agent-runs/:runId/research-setup", {
    schema: {
      description: "Owner-only — read the open setup session for an intent run, if any.",
      response: {
        200: toJsonSchema(personalResearchSetupSessionEnvelopeSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    await getAuthorizedAgentRun(runId, request.user.id);
    const session = await loadSessionForOwner({ runId, ownerUserId: request.user.id });
    if (!session) {
      throw new ApiError(404, "Not Found", "Setup session not found");
    }
    return reply.code(200).send(personalResearchSetupSessionEnvelopeSchema.parse({ session }));
  });

  app.post("/agent-runs/:runId/research-setup", {
    schema: {
      description: "Owner-only — open or refresh the setup session for an intent run.",
      response: {
        200: toJsonSchema(personalResearchSetupSessionEnvelopeSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
        409: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    const tripId = await loadRunTripId(runId, request.user.id);
    const capabilities = (await getAuthorizedAgentRun(runId, request.user.id)).researchIntentDraft?.requestedCapabilities ?? [];
    const ctx = createRequestContext(
      request.user.id,
      request.correlationId,
      request.traceId,
      request.clientRequestId,
      request.traceparent,
      request.tracestate,
      request.spanId,
    );
    const session = await getOrOpenSession({
      ctx,
      runId,
      tripId,
      ownerUserId: request.user.id,
      requestedCapabilities: capabilities as Array<
        "flight" | "accommodation" | "hotel" | "activities" | "places" | "navigation" | "mobility" | "readiness"
      >,
    });
    return reply.code(200).send(personalResearchSetupSessionEnvelopeSchema.parse({ session }));
  });

  app.post("/agent-runs/:runId/research-setup/answers", {
    schema: {
      description: "Owner-only — apply a single-field patch under optimistic-version concurrency.",
      response: {
        200: toJsonSchema(personalResearchSetupSessionEnvelopeSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
        409: toJsonSchema(errorResponseSchema),
        410: toJsonSchema(errorResponseSchema),
        422: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    await getAuthorizedAgentRun(runId, request.user.id);
    const body = personalResearchSetupApplyRequestSchema.parse(request.body);
    const ctx = createRequestContext(
      request.user.id,
      request.correlationId,
      request.traceId,
      request.clientRequestId,
      request.traceparent,
      request.tracestate,
      request.spanId,
    );
    const session = await applyAnswer({
      ctx,
      runId,
      ownerUserId: request.user.id,
      expectedVersion: body.expectedVersion,
      patch: body.patch,
    });
    return reply.code(200).send(personalResearchSetupSessionEnvelopeSchema.parse({ session }));
  });

  app.post("/agent-runs/:runId/research-setup/cancel", {
    schema: {
      description: "Owner-only — cancel an open setup session.",
      response: {
        200: toJsonSchema(z.object({ status: z.literal("CANCELLED") }).strict()),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
        409: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    await getAuthorizedAgentRun(runId, request.user.id);
    const ctx = createRequestContext(
      request.user.id,
      request.correlationId,
      request.traceId,
      request.clientRequestId,
      request.traceparent,
      request.tracestate,
      request.spanId,
    );
    const result = await cancelSession({
      ctx,
      runId,
      ownerUserId: request.user.id,
    });
    return reply.code(200).send(result);
  });

  app.post("/agent-runs/:runId/research-setup/confirm-and-search", {
    schema: {
      description: "Owner-only — atomic confirm + RESEARCH task acceptance.",
      response: {
        202: toJsonSchema(personalResearchSetupConfirmAcceptedResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
        409: toJsonSchema(errorResponseSchema),
        410: toJsonSchema(errorResponseSchema),
        422: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    const tripId = await loadRunTripId(runId, request.user.id);
    const body = personalResearchSetupConfirmRequestSchema.parse(request.body);
    const ctx = createRequestContext(
      request.user.id,
      request.correlationId,
      request.traceId,
      request.clientRequestId,
      request.traceparent,
      request.tracestate,
      request.spanId,
    );
    const accepted = await confirmAndSearch({
      ctx,
      runId,
      ownerUserId: request.user.id,
      tripId,
      requestId: body.requestId,
    });
    return reply.code(202).send(accepted);
  });
}
