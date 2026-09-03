import { z } from "zod";
import type { FastifyInstance } from "fastify";

import { ApiError } from "../middleware/error-handler.js";
import { metrics } from "../observability/metrics.js";
import { logSafeRuntimeEvent } from "../observability/telemetry.js";
import { safeSetAttribute } from "../observability/tracing.js";
import { createRequestContext } from "../utils/context.js";
import { errorResponseSchema, toJsonSchema } from "../types/schemas.js";

// The server-side allow-list MUST stay in lockstep with the client's
// `UI_ACTIONS` in `apps/web/src/lib/observability/ui-diagnostics.ts`:
// any client-declared action that is not also present here is rejected
// with 422 by the Zod enum. When the client adds a new event, add the
// string here in the same commit.
const actions = [
  "frontend.runtime", "profile.save", "trip.activate", "trip.thread_create", "conversation.submit",
  "agent.run_cancel", "invitation.accept", "invitation.decline", "plan.confirm", "booking.confirm",
  // Phase 6 / Personal Trip Orchestrator
  "research.command_confirm", "research.command_reject", "research.stage_view", "research.intent_dismiss",
  // Personal Research Setup Sessions (§9) — kept for parity with the
  // historical client allow-list, even though those flows are no longer
  // wired client-side after migration 0049.
  "setup.session_open", "setup.field_update", "setup.confirm", "setup.cancel", "setup.followup_received",
  // Phase 2 — Real-provider acknowledgement (flight / hotel / etc.)
  "research.real_provider_acknowledged", "research.real_provider_declined",
  // Phase 6 / Member conversation handoff
  "conversation.handoff_confirm",
  // Shared Plan Surface (Phase 4)
  "shared_plan.view_open", "shared_plan.vote_cast",
] as const;
const screens = ["home", "explore", "projects", "trip", "profile", "login", "register", "forgot_password", "unknown"] as const;
const errorCategories = [
  "none", "validation", "network", "http_4xx", "http_5xx", "timeout", "aborted", "invalid_response", "render", "unhandled",
] as const;

const uiDiagnosticEventSchema = z.object({
  eventType: z.enum(["ui_api_request", "ui_action", "ui_client_error"]),
  action: z.enum(actions),
  screen: z.enum(screens),
  outcome: z.enum(["success", "failure"]),
  errorCategory: z.enum(errorCategories),
  durationMs: z.number().int().min(0).max(120_000).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  relatedCorrelationId: z.string().uuid().optional(),
  relatedClientRequestId: z.string().uuid().optional(),
}).strict();

const acceptedResponseSchema = z.object({ accepted: z.literal(true) }).strict();

/** A deliberately local, in-memory abuse guard; it stores no event content. */
class UiDiagnosticsRateLimiter {
  private readonly buckets = new Map<string, { startedAt: number; count: number }>();

  allow(ip: string, now = Date.now()): boolean {
    const previous = this.buckets.get(ip);
    if (!previous || now - previous.startedAt >= 60_000) {
      this.buckets.set(ip, { startedAt: now, count: 1 });
      return true;
    }
    if (previous.count >= 60) return false;
    previous.count += 1;
    return true;
  }
}

export async function uiDiagnosticsRoutes(app: FastifyInstance) {
  const limiter = new UiDiagnosticsRateLimiter();
  app.post("/diagnostics/ui-events", {
    schema: {
      description: "Authenticated, allow-listed browser diagnostics. Event content, URLs, stacks and user input are rejected.",
      response: { 202: toJsonSchema(acceptedResponseSchema), 400: toJsonSchema(errorResponseSchema), 429: toJsonSchema(errorResponseSchema) },
    },
  }, async (request, reply) => {
    if (!limiter.allow(request.ip)) {
      throw new ApiError(429, "Too Many Requests", "Too many diagnostic events. Please try again later.", "UI_DIAGNOSTICS_RATE_LIMITED");
    }
    const event = uiDiagnosticEventSchema.parse(request.body);
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    safeSetAttribute(request._otelSpan, "ui.event_type", event.eventType);
    safeSetAttribute(request._otelSpan, "ui.action", event.action);
    safeSetAttribute(request._otelSpan, "ui.screen", event.screen);
    safeSetAttribute(request._otelSpan, "ui.outcome", event.outcome);
    safeSetAttribute(request._otelSpan, "ui.error_category", event.errorCategory);
    if (event.httpStatus !== undefined) safeSetAttribute(request._otelSpan, "ui.http_status", event.httpStatus);

    logSafeRuntimeEvent(ctx, {
      component: "ui",
      event: event.eventType,
      operation: event.action,
      outcome: event.outcome,
      errorCode: event.errorCategory === "none" ? undefined : event.errorCategory,
      latencyMs: event.durationMs,
      screen: event.screen,
      httpStatus: event.httpStatus,
      relatedCorrelationId: event.relatedCorrelationId,
      relatedClientRequestId: event.relatedClientRequestId,
    });
    metrics.inc("ui_diagnostic_events_total", {
      action: event.action,
      outcome: event.outcome,
      error_category: event.errorCategory,
    });
    return reply.code(202).send({ accepted: true });
  });
}

export const UI_DIAGNOSTIC_ACTIONS = actions;
