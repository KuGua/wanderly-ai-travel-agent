import type { FastifyInstance, FastifyReply } from "fastify";

import { SpanKind } from "@opentelemetry/api";
import { createRequestContext } from "../utils/context.js";
import { agentTaskConfig } from "../tasks/config.js";
import type { AgentStreamRelay } from "../tasks/agent-stream-relay.js";
import {
  getAuthorizedAgentRun,
  requestAgentTaskCancellation,
} from "../tasks/task-repository.js";
import {
  agentStreamEventSchema,
  tripPlanningRunDetailResponseSchema,
  uuidSchema,
  type AgentStreamEvent,
} from "../types/schemas.js";
import { db } from "../db/database.js";
import { agentStreamEvents, agentTaskRuns, planningResearchResults } from "../db/schema.js";
import { and, asc, gt, eq } from "drizzle-orm";
import { ApiError } from "../middleware/error-handler.js";
import {
  getTracer,
  parseTraceparent,
  safeSetAttribute,
} from "../observability/tracing.js";

export async function agentRunRoutes(
  app: FastifyInstance,
  options: { relay: AgentStreamRelay },
) {
  app.get("/agent-runs/:runId", async (request) => {
    const runId = readRunId(request.params);
    return getAuthorizedAgentRun(runId, request.user.id);
  });

  // This is intentionally trip-scoped rather than a generic run inspector:
  // members may inspect a shared planning outcome, while private conversation
  // and PERSONAL_RESEARCH runs remain outside this surface.
  app.get("/trips/:tripId/runs/:runId", async (request) => {
    const runId = readRunId(request.params);
    const tripId = uuidSchema.parse((request.params as { tripId?: unknown }).tripId);
    const run = await getAuthorizedAgentRun(runId, request.user.id);
    const [stored] = await db.select({ tripId: agentTaskRuns.tripId }).from(agentTaskRuns)
      .where(eq(agentTaskRuns.id, runId)).limit(1);
    if (stored?.tripId !== tripId || !["PLAN", "REPLAN", "RESEARCH"].includes(run.operation)) {
      throw new ApiError(404, "Not Found", "Planning run not found for this trip");
    }
    const [research] = await db.select().from(planningResearchResults)
      .where(eq(planningResearchResults.agentTaskRunId, runId))
      .limit(1);
    return tripPlanningRunDetailResponseSchema.parse({
      run,
      research: research ? {
        id: research.id,
        tripId: research.tripId,
        snapshotId: research.snapshotId,
        agentTaskRunId: research.agentTaskRunId,
        status: research.status,
        serviceGaps: research.serviceGaps,
        resultPlanId: research.resultPlanId,
        offers: [],
        createdAt: research.createdAt.toISOString(),
      } : null,
    });
  });

  app.post("/agent-runs/:runId/cancel", async (request) => {
    const runId = readRunId(request.params);
    return requestAgentTaskCancellation({
      ctx: createRequestContext(
        request.user.id,
        request.correlationId,
        request.traceId,
        request.clientRequestId,
        request.traceparent,
        request.tracestate,
        request.spanId,
      ),
      runId,
      userId: request.user.id,
    });
  });

  app.get("/agent-runs/:runId/events", async (request, reply) => {
    const runId = readRunId(request.params);
    await getAuthorizedAgentRun(runId, request.user.id);
    const afterEventId = readLastEventId(request.headers["last-event-id"]);

    // Open the SSE stream root span. The span is a sibling of the inbound
    // HTTP server span — events fan in from the Worker via NOTIFY/LISTEN
    // and arrive minutes after the originating HTTP request may have ended,
    // so we use `links` (rather than parenting) to keep causality without
    // holding the parent alive.
    const streamSpan = getTracer().startSpan("sse.stream", {
      kind: SpanKind.SERVER,
      attributes: {
        "sse.run.id": runId,
      },
    });
    let activeTraceparent: string | undefined = request.traceparent;

    // `reply.hijack()` hands the socket to this handler and skips Fastify's
    // onSend chain, so headers already negotiated by onRequest hooks — the CORS
    // decision and the correlation id — must be written onto the raw stream
    // explicitly. Without them a browser blocks the cross-origin stream and
    // silently degrades to polling the durable run instead of streaming.
    const negotiatedHeaders = negotiatedStreamHeaders(reply);
    reply.hijack();
    reply.raw.writeHead(200, {
      ...negotiatedHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const tracer = getTracer();
    const unsubscribe = options.relay.subscribe(runId, (event) => {
      if (reply.raw.destroyed) return;
      if (event.traceparent && !activeTraceparent) {
        activeTraceparent = event.traceparent;
      }
      const parsedTp = event.traceparent ? parseTraceparent(event.traceparent) : null;
      const links = parsedTp
        ? [{ context: { traceId: parsedTp.traceId, spanId: parsedTp.spanId, isRemote: true, traceFlags: 1 } }]
        : undefined;
      const eventSpan = tracer.startSpan(
        `sse.event.${event.event}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "sse.run.id": runId,
            "sse.event.type": event.event,
          },
          links,
        },
      );
      try {
        reply.raw.write(serializeSseEvent(event));
      } finally {
        safeSetAttribute(eventSpan, "sse.outcome", "delivered");
        eventSpan.end();
      }
    });
    // Subscribe before the database read so a frame written during replay is
    // delivered live. The client de-duplicates by streamEventId if it also
    // appears in the replay result.
    const replay = await db.select({ id: agentStreamEvents.id, event: agentStreamEvents.event })
      .from(agentStreamEvents)
      .where(afterEventId === 0
        ? eq(agentStreamEvents.runId, runId)
        : and(eq(agentStreamEvents.runId, runId), gt(agentStreamEvents.id, afterEventId)))
      .orderBy(asc(agentStreamEvents.id))
      .limit(1_000);
    for (const row of replay) {
      const parsed = agentStreamEventSchema.safeParse({ ...row.event, streamEventId: String(row.id) });
      if (parsed.success && parsed.data.runId === runId) reply.raw.write(serializeSseEvent(parsed.data));
    }
    const keepAlive = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": keep-alive\n\n");
    }, agentTaskConfig.streamKeepAliveMs);
    request.raw.once("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      safeSetAttribute(streamSpan, "sse.outcome", "closed");
      streamSpan.end();
    });
  });
}

/** Copies the headers Fastify already negotiated onto a hijacked raw response. */
function negotiatedStreamHeaders(reply: FastifyReply): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value : String(value);
  }
  return headers;
}

function readRunId(params: unknown): string {
  return uuidSchema.parse((params as { runId?: unknown }).runId);
}

function readLastEventId(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function serializeSseEvent(event: AgentStreamEvent) {
  const { event: eventName, streamEventId, ...data } = event;
  return (streamEventId ? "id: " + streamEventId + "\n" : "")
    + "event: " + eventName + "\n" + "data: " + JSON.stringify({ ...data, ...(streamEventId ? { streamEventId } : {}) }) + "\n\n";
}
