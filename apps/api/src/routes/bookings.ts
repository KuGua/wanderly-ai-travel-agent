import type { FastifyInstance } from "fastify";
import { db } from "../db/database.js";
import { tripMembers } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { bookingRequestSchema, sandboxCallbackSchema } from "../types/schemas.js";
import { submitBooking, handleSandboxCallback } from "../services/booking-service.js";
import { createRequestContext } from "../utils/context.js";
import { ApiError } from "../middleware/error-handler.js";
import { verifySandboxSignature } from "../middleware/sandbox-signature.js";
import { metrics } from "../observability/metrics.js";
import { pinoInstance } from "../observability/telemetry.js";

const DEV_SANDBOX_SECRET = "dev-sandbox-secret-do-not-use-in-prod";
const sandboxSecret = process.env.SANDBOX_HMAC_SECRET ?? DEV_SANDBOX_SECRET;
if (!process.env.SANDBOX_HMAC_SECRET) {
  pinoInstance.warn({ dev: true }, "SANDBOX_HMAC_SECRET unset — using insecure dev default");
}

export async function bookingRoutes(app: FastifyInstance) {
  app.post("/bookings", async (request) => {
    const ctx = createRequestContext(request.user.id, request.correlationId, request.traceId);
    const body = bookingRequestSchema.parse(request.body);

    const membership = await db.select().from(tripMembers)
      .where(and(eq(tripMembers.tripId, body.tripId), eq(tripMembers.userId, request.user.id)))
      .limit(1);

    if (membership.length === 0) {
      throw new ApiError(403, "Forbidden", "Not a member of this trip");
    }

    try {
      const result = await submitBooking({
        ctx,
        planId: body.planId,
        tripId: body.tripId,
        orchestrationRequestId: body.orchestrationRequestId,
        requestedBy: request.user.id,
      });

      return {
        message: result.isDuplicate ? "Duplicate request — returning cached result" : "Booking submitted",
        ...result,
      };
    } catch (error: unknown) {
      throw new ApiError(
        400,
        "Bad Request",
        error instanceof Error ? error.message : "Unknown booking error",
      );
    }
  });

  // Sandbox callback — provider-authenticated via HMAC; never trusts the
  // X-Demo-User header for this endpoint.
  app.post("/bookings/callback", {
    config: { rawBody: true },
  }, async (request) => {
    const ctx = createRequestContext(undefined, request.correlationId, request.traceId);
    const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
    const headers = request.headers as Record<string, string | string[] | undefined>;

    const verify = verifySandboxSignature(headers, rawBody, sandboxSecret);
    if (!verify.ok) {
      metrics.inc("booking_gate_denials_total", { reason: verify.reason });
      throw new ApiError(401, "Unauthorized", `Sandbox signature rejected: ${verify.reason}`);
    }

    const body = sandboxCallbackSchema.parse(request.body);

    try {
      const result = await handleSandboxCallback({
        ctx,
        orchestrationRequestId: body.orchestrationRequestId,
        eventId: body.eventId,
        serviceResults: body.serviceResults,
      });

      return {
        message: result.isDuplicate ? "Duplicate callback — ignored" : "Callback processed",
        ...result,
      };
    } catch (error: unknown) {
      throw new ApiError(
        400,
        "Bad Request",
        error instanceof Error ? error.message : "Unknown callback error",
      );
    }
  });
}