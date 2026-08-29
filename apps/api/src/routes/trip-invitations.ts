import { z } from "zod";
import type { FastifyInstance } from "fastify";

import {
  acceptInvitation,
  createInvitation,
  declineInvitation,
  getInvitationPreview,
  revokeInvitation,
} from "../services/trip-invitation-service.js";
import { createRequestContext } from "../utils/context.js";
import {
  acceptInvitationResponseSchema,
  createTripInvitationSchema,
  declineInvitationResponseSchema,
  toJsonSchema,
  tripInvitationCreateResponseSchema,
  tripInvitationPreviewResponseSchema,
} from "../types/schemas.js";

const tripIdParamSchema = z.object({ tripId: z.string().uuid() }).strict();
const invitationIdParamSchema = z.object({
  tripId: z.string().uuid(),
  invitationId: z.string().uuid(),
}).strict();
const inviteTokenParamSchema = z.object({ inviteToken: z.string().min(32).max(256) }).strict();

export async function tripInvitationRoutes(app: FastifyInstance) {
  // Only the trip creator may invite additional members.
  app.post("/trips/:tripId/invitations", {
    schema: {
      description: "Create a one-time invitation for a registered user to join a Trip.",
      tags: ["invitations"],
      params: toJsonSchema(tripIdParamSchema),
      body: toJsonSchema(createTripInvitationSchema),
      response: { 201: toJsonSchema(tripInvitationCreateResponseSchema) },
    },
  }, async (request, reply) => {
    const { tripId } = tripIdParamSchema.parse(request.params);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const body = createTripInvitationSchema.parse(request.body);
    const expiresAt = new Date(body.expiresAt);
    const result = await createInvitation({
      ctx,
      tripId,
      invitedUserId: body.invitedUserId,
      expiresAt,
      actorUserId: request.user.id,
    });
    return reply.code(201).send({
      invitationId: result.invitationId,
      inviteToken: result.inviteToken,
      expiresAt: result.expiresAt.toISOString(),
    });
  });

  app.get("/trip-invitations/:inviteToken", {
    schema: {
      description: "Read the authenticated recipient's minimal invitation decision summary.",
      tags: ["invitations"],
      params: toJsonSchema(inviteTokenParamSchema),
      response: { 200: toJsonSchema(tripInvitationPreviewResponseSchema) },
    },
  }, async (request, reply) => {
    const { inviteToken } = inviteTokenParamSchema.parse(request.params);
    const result = await getInvitationPreview({ token: inviteToken, actorUserId: request.user.id });
    return reply.code(200).send(tripInvitationPreviewResponseSchema.parse({
      ...result,
      membership: "MEMBER",
      isRequired: true,
      expiresAt: result.expiresAt.toISOString(),
    }));
  });

  // The invited authenticated user redeems a one-time token.
  app.post("/trip-invitations/:inviteToken/accept", {
    schema: {
      description: "Accept a Trip invitation using its one-time token.",
      tags: ["invitations"],
      params: toJsonSchema(inviteTokenParamSchema),
      response: { 200: toJsonSchema(acceptInvitationResponseSchema) },
    },
  }, async (request, reply) => {
    const { inviteToken } = inviteTokenParamSchema.parse(request.params);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const result = await acceptInvitation({
      ctx,
      token: inviteToken,
      actorUserId: request.user.id,
    });
    return reply.code(200).send(acceptInvitationResponseSchema.parse({
      tripId: result.tripId,
      membership: "MEMBER",
      defaultThread: {
        id: result.defaultThreadId,
        tripId: result.tripId,
        isDefault: true,
      },
    }));
  });

  app.post("/trip-invitations/:inviteToken/decline", {
    schema: {
      description: "Decline a pending Trip invitation using its one-time token.",
      tags: ["invitations"],
      params: toJsonSchema(inviteTokenParamSchema),
      response: { 200: toJsonSchema(declineInvitationResponseSchema) },
    },
  }, async (request, reply) => {
    const { inviteToken } = inviteTokenParamSchema.parse(request.params);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    await declineInvitation({ ctx, token: inviteToken, actorUserId: request.user.id });
    return reply.code(200).send({ declined: true });
  });

  // Trip creator revokes a still-pending invitation.
  app.post("/trips/:tripId/invitations/:invitationId/revoke", {
    schema: {
      description: "Revoke a pending Trip invitation.",
      tags: ["invitations"],
      params: toJsonSchema(invitationIdParamSchema),
      response: { 204: { type: "null" } },
    },
  }, async (request, reply) => {
    const { invitationId } = invitationIdParamSchema.parse(request.params);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    await revokeInvitation({ ctx, invitationId, actorUserId: request.user.id });
    return reply.code(204).send();
  });
}
