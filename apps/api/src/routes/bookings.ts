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

const SANDBOX_SECRET_PLACEHOLDER = "replace-with-a-local-random-secret-at-least-32-bytes";

export async function bookingRoutes(app: FastifyInstance) {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = body.toString("utf8");
    request.rawBody = rawBody;
    try {
      done(null, rawBody.length === 0 ? null : JSON.parse(rawBody));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

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

  // Sandbox callback — provider-authenticated via HMAC; never trusts a user
  // bearer token for this endpoint.
  app.post("/bookings/callback", async (request) => {
    const ctx = createRequestContext(undefined, request.correlationId, request.traceId);
    const rawBody = request.rawBody ?? "";
    const headers = request.headers as Record<string, string | string[] | undefined>;

    const configuredSecret = process.env.SANDBOX_HMAC_SECRET?.trim();
    const secret = configuredSecret && configuredSecret !== SANDBOX_SECRET_PLACEHOLDER
      ? configuredSecret
      : undefined;
    const verify = verifySandboxSignature(headers, rawBody, secret);
    if (!verify.ok) {
      metrics.inc("callback_verifications_total", { callbackResult: verify.reason });
      metrics.inc("booking_gate_denials_total", { errorCategory: "callback_auth" });
      throw new ApiError(
        401,
        "Unauthorized",
        "Callback authentication failed",
        `CALLBACK_${verify.reason.toUpperCase()}`,
      );
    }
    metrics.inc("callback_verifications_total", { callbackResult: "valid" });

    try {
      const body = sandboxCallbackSchema.parse(request.body);
      const result = await handleSandboxCallback({
        ctx,
        orchestrationRequestId: body.orchestrationRequestId,
        eventId: body.eventId,
        serviceResults: body.serviceResults,
      });

      if (result.isStale) {
        // Booking already reached a terminal state — the callback cannot
        // be applied. Surface as 409 so retrying callers know to abandon.
        metrics.inc("booking_callback_outcomes_total", { callbackResult: "stale" });
        throw new ApiError(
          409,
          "Conflict",
          "Booking is already in a terminal state; callback cannot be applied",
          "STALE_CALLBACK",
        );
      }

      metrics.inc("booking_callback_outcomes_total", {
        callbackResult: result.isDuplicate ? "duplicate" : "processed",
      });

      return {
        message: result.isDuplicate ? "Duplicate callback — ignored" : "Callback processed",
        ...result,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      metrics.inc("booking_callback_outcomes_total", { callbackResult: "failed" });
      throw new ApiError(
        400,
        "Bad Request",
        "Callback could not be processed",
        "CALLBACK_PROCESSING_REJECTED",
      );
    }
  });
}
