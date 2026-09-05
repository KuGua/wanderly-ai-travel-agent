import { and, asc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { DefaultPolicyGate } from "../agents/policy-gate.js";
import { invokeSkill } from "../agents/skill-registry.js";
import { chatMessages, chatThreads, sharedTrips } from "../db/schema.js";
import { db } from "../db/database.js";
import { metrics } from "../observability/metrics.js";
import { logSafeRuntimeEvent } from "../observability/telemetry.js";
import { applyTitleDestinationLabel } from "../services/trip-title-label-service.js";
import { postprocessTripDestinationLabel } from "../services/trip-destination-label-postprocess.js";
import { runLlmSuggestEnvelope } from "../services/llm-suggest-envelope.js";
import { createRequestContext } from "../utils/context.js";
import { errorResponseSchema, toJsonSchema } from "../types/schemas.js";
import {
  TripDestinationLabelRateLimiter,
  TRIP_DESTINATION_LABEL_RATE_LIMIT,
  TRIP_DESTINATION_LABEL_RATE_WINDOW_MS,
} from "./trip-destination-label-rate-limit.js";

/**
 * POST /api/v1/trips/:tripId/title/suggest — owner-triggered LLM
 * destination-label suggest
 * (docs/trip-title-destination-label-implementation.md §9.1).
 *
 * Returns 200 with `{ trip, applied, reason? }`. The route never throws to
 * the framework on business failure; every bounded reason is mapped to a
 * `{ applied: false, reason }` response so the workspace UI can show a
 * stable, recoverable copy.
 *
 * 403 (non-owner) and 404 (no such trip) are deliberately distinguishable —
 * UUIDs prevent collision between the two codes, so a "no such trip" signal
 * is preserved instead of being folded into 403.
 */

const MAX_INPUT_MESSAGES = 3;
const MAX_MESSAGE_TEXT = 512;

const tripIdParamSchema = z.object({ tripId: z.string().uuid() }).strict();

const suggestRequestSchema = z.object({
  locale: z.enum(["en", "zh"]),
}).strict();

const SUGGEST_REASON = z.enum([
  "NOT_DRAFT",
  "MANUAL_LOCKED",
  "SUPERSEDED",
  "NO_MATERIAL",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "REJECTED",
]);

const suggestResponseSchema = z.object({
  trip: z.object({
    id: z.string().uuid(),
    name: z.string(),
    nameSource: z.enum(["AUTO", "MANUAL"]),
    titleDestinationLabel: z.string().nullable().optional(),
    titleLabelSource: z.enum(["REFERENCE", "LLM"]).nullable().optional(),
  }),
  applied: z.boolean(),
  reason: SUGGEST_REASON.optional(),
}).strict();

const rateLimiter = new TripDestinationLabelRateLimiter(
  TRIP_DESTINATION_LABEL_RATE_LIMIT,
  TRIP_DESTINATION_LABEL_RATE_WINDOW_MS,
);

type TripSummary = z.infer<typeof suggestResponseSchema>["trip"];
type SuggestReason = z.infer<typeof SUGGEST_REASON>;

export async function tripTitleSuggestRoutes(app: FastifyInstance): Promise<void> {
  app.post("/trips/:tripId/title/suggest", {
    schema: {
      description:
        "Owner-triggered suggestion for the display-only trip destination label. "
        + "Calls the personal LLM with at most three of the owner's own USER "
        + "messages, re-resolves the model's output against the location "
        + "reference data, and writes the canonical name to "
        + "shared_trips.title_destination_label. The label never enters "
        + "destinationCandidates or any provider query (D3).",
      tags: ["trips"],
      params: toJsonSchema(tripIdParamSchema),
      body: toJsonSchema(suggestRequestSchema),
      response: {
        200: toJsonSchema(suggestResponseSchema),
        403: toJsonSchema(errorResponseSchema),
        404: toJsonSchema(errorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const ctx = createRequestContext(
      request.user.id, request.correlationId, request.traceId,
      request.clientRequestId, request.traceparent, request.tracestate, request.spanId,
    );
    const { tripId } = tripIdParamSchema.parse(request.params);
    const body = suggestRequestSchema.parse(request.body);

    // 1. Trip exists + caller is the creator. UUIDs make 404 vs 403 safe.
    const [trip] = await db.select({
      id: sharedTrips.id,
      createdBy: sharedTrips.createdBy,
      status: sharedTrips.status,
      nameSource: sharedTrips.nameSource,
      name: sharedTrips.name,
      titleDestinationLabel: sharedTrips.titleDestinationLabel,
      titleLabelSource: sharedTrips.titleLabelSource,
    }).from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
    if (!trip) {
      return reply.code(404).send(errorResponseSchema.parse({
        statusCode: 404, error: "Not Found",
        message: "Trip not found",
        correlationId: ctx.correlationId,
      }));
    }
    if (trip.createdBy !== request.user.id) {
      return reply.code(403).send(errorResponseSchema.parse({
        statusCode: 403, error: "Forbidden",
        message: "Only the trip creator may suggest a destination label",
        correlationId: ctx.correlationId,
      }));
    }

    const buildSummary = (overrides?: Partial<TripSummary>): TripSummary => ({
      id: trip.id,
      name: overrides?.name ?? trip.name,
      nameSource: overrides?.nameSource ?? trip.nameSource,
      titleDestinationLabel: overrides?.titleDestinationLabel ?? trip.titleDestinationLabel,
      titleLabelSource: overrides?.titleLabelSource ?? trip.titleLabelSource,
    });

    const reject = async (reason: SuggestReason): Promise<unknown> => {
      metrics.inc("trip_title_writes_total", {
        source: "llm",
        result: reasonToMetricResult(reason),
      });
      return reply.code(200).send(suggestResponseSchema.parse({
        trip: buildSummary(),
        applied: false,
        reason,
      }));
    };

    // 2. Rate limit. Bound the per-user cost of the LLM call.
    if (!rateLimiter.allow(request.user.id)) {
      return reject("RATE_LIMITED");
    }

    // 3. NO_MATERIAL — pull the owner's default thread; reject if no USER
    // messages yet. No point spending an LLM call on an empty transcript.
    const [defaultThread] = await db.select({ id: chatThreads.id })
      .from(chatThreads)
      .where(and(
        eq(chatThreads.tripId, tripId),
        eq(chatThreads.ownerUserId, request.user.id),
        eq(chatThreads.isDefault, true),
        isNull(chatThreads.archivedAt),
      ))
      .limit(1);
    const userMessages = defaultThread
      ? await db.select({ body: chatMessages.body })
        .from(chatMessages)
        .where(and(
          eq(chatMessages.threadId, defaultThread.id),
          eq(chatMessages.role, "USER"),
        ))
        .orderBy(asc(chatMessages.createdAt))
        .limit(MAX_INPUT_MESSAGES)
      : [];
    if (userMessages.length === 0) {
      return reject("NO_MATERIAL");
    }
    const truncatedMessages = userMessages.map((m) => ({ text: m.body.slice(0, MAX_MESSAGE_TEXT) }));

    // 4. Envelope: skill invoke + postprocess + bounded reason mapping.
    // The envelope returns the *postprocessed* label, so what reaches the
    // trip row below is the dataset's canonical name — never the model's raw
    // text. That distinction is the whole point of the closed-vocabulary
    // contract (spec §D5): a zh caller whose model answered "France" must
    // still persist 法国, and "tokyo" must persist as Tokyo.
    const envelopeResult = await runLlmSuggestEnvelope<
      { kind: "COUNTRY" | "CITY"; value: string },
      { kind: "COUNTRY" | "CITY"; value: string }
    >({
      ctx,
      operation: "trip.destination.label",
      invoke: async () => invokeSkill(
        "trip.destination.label.suggest",
        { ctx, policyGate: new DefaultPolicyGate("personal") },
        { tripId, locale: body.locale, messages: truncatedMessages },
      ) as Promise<{ kind: "COUNTRY" | "CITY"; value: string }>,
      postprocess: (raw) => {
        const cleaned = postprocessTripDestinationLabel(
          { kind: raw.kind, value: raw.value },
          body.locale,
        );
        return cleaned.ok
          ? { ok: true, value: { kind: cleaned.kind, value: cleaned.value } }
          : { ok: false };
      },
    });

    if (!envelopeResult.ok) return reject(envelopeResult.reason);

    // 5. Persist via the shared service. It owns the FOR UPDATE re-read,
    // the MANUAL_LOCKED / NOT_DRAFT / SUPERSEDED / UNCHANGED gates, and
    // the audit + metric calls — same gates that protect the REFERENCE
    // path, so concurrent owner-rename or city-confirm never gets
    // overwritten.
    const applied = await applyTitleDestinationLabel({
      ctx,
      tripId,
      label: envelopeResult.output.value,
      source: "LLM",
      locale: body.locale,
    }).catch((err): { applied: false; reason: "UNAVAILABLE" } => {
      // Fail-soft. A persistence error must not crash the request; the
      // envelope has already spent the LLM call and the user is waiting.
      logSafeRuntimeEvent(ctx, {
        component: "llm", event: "apply",
        operation: "trip.destination.label",
        outcome: "failure",
        errorCode: (err as Error)?.name ?? "UNKNOWN",
      });
      metrics.inc("trip_title_writes_total", { source: "llm", result: "unavailable" });
      return { applied: false, reason: "UNAVAILABLE" };
    });

    if (applied.applied) {
      // Re-read the trip so the response carries the post-write name.
      const [updated] = await db.select({
        name: sharedTrips.name,
        nameSource: sharedTrips.nameSource,
        titleDestinationLabel: sharedTrips.titleDestinationLabel,
        titleLabelSource: sharedTrips.titleLabelSource,
      }).from(sharedTrips).where(eq(sharedTrips.id, tripId)).limit(1);
      return reply.code(200).send(suggestResponseSchema.parse({
        trip: buildSummary({
          name: updated?.name ?? trip.name,
          nameSource: updated?.nameSource ?? trip.nameSource,
          titleDestinationLabel: updated?.titleDestinationLabel ?? trip.titleDestinationLabel,
          titleLabelSource: updated?.titleLabelSource ?? trip.titleLabelSource,
        }),
        applied: true,
      }));
    }
    // The persist step's bounded reasons — map them onto the route's enum.
    // UNCHANGED (an identical previous write) is rare; collapse into
    // SUPERSEDED so the UI can show "your label is already in place" copy
    // without a dedicated reason.
    return reject(applied.reason === "UNCHANGED" ? "SUPERSEDED" : applied.reason);
  });
}

function reasonToMetricResult(
  reason: SuggestReason,
): "not_draft" | "manual_locked" | "superseded" | "no_material" | "rate_limited" | "rejected" | "unavailable" {
  switch (reason) {
    case "NOT_DRAFT": return "not_draft";
    case "MANUAL_LOCKED": return "manual_locked";
    case "SUPERSEDED": return "superseded";
    case "NO_MATERIAL": return "no_material";
    case "RATE_LIMITED": return "rate_limited";
    // Both values are registered on `trip_title_writes_total`. Folding them
    // into `superseded` left them permanently at zero, which hides exactly
    // the two signals an operator needs: a sustained REJECTED rate points at
    // a prompt or model regression, and UNAVAILABLE at gateway health.
    case "REJECTED": return "rejected";
    case "UNAVAILABLE": return "unavailable";
  }
}
