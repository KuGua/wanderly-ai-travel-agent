import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { grantConsentSchema, revokeConsentSchema } from "../types/schemas.js";
import { grantConsent, revokeConsent, getActiveConsents } from "../services/consent-service.js";
import { createRequestContext } from "../utils/context.js";
import { ApiError } from "../middleware/error-handler.js";

export async function consentRoutes(app: FastifyInstance) {
  // Grant consent
  app.post("/consent/grant", {
    
      

  }, async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = grantConsentSchema.parse(request.body);

    // Verify membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    await grantConsent({
      ctx,
      tripId: body.tripId,
      userId: request.user.id,
      scope: body.scope,
      fieldList: body.fieldList,
    });

    return { message: "Consent granted", scope: body.scope, fieldList: body.fieldList };
  });

  // Revoke consent
  app.post("/consent/revoke", {
    
      

  }, async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId, request.clientRequestId, request.traceparent, request.tracestate, request.spanId);
    const body = revokeConsentSchema.parse(request.body);

    // Verify membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    await revokeConsent({
      ctx,
      tripId: body.tripId,
      userId: request.user.id,
      scope: body.scope,
    });

    return { message: "Consent revoked", scope: body.scope };
  });

  // Get my active consents for a trip
  app.get("/consent/:tripId/me", async (request) => {
    const { tripId } = request.params as { tripId: string };

    // Verify membership
    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    const consents = await getActiveConsents({ tripId, userId: request.user.id });
    return { consents };
  });
}
