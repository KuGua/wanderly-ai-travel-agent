import type { FastifyInstance, FastifyReply } from "fastify";

import { createRequestContext } from "../utils/context.js";
import { logger } from "../utils/logger.js";
import { agentTaskConfig } from "../tasks/config.js";
import type { AgentStreamRelay } from "../tasks/agent-stream-relay.js";
import {
  getAuthorizedAgentRun,
  requestAgentTaskCancellation,
} from "../tasks/task-repository.js";
import { uuidSchema, type AgentStreamEvent } from "../types/schemas.js";

export async function agentRunRoutes(
  app: FastifyInstance,
  options: { relay: AgentStreamRelay },
) {
  app.get("/agent-runs/:runId", async (request) => {
    const runId = readRunId(request.params);
    return getAuthorizedAgentRun(runId, request.user.id);
  });

  app.post("/agent-runs/:runId/cancel", async (request) => {
    const runId = readRunId(request.params);
    return requestAgentTaskCancellation({
      ctx: createRequestContext(
        request.user.id,
        request.correlationId,
        request.traceId,
        request.clientRequestId,
      ),
      runId,
      userId: request.user.id,
    });
  });

  app.get("/agent-runs/:runId/events", async (request, reply) => {
    const runId = readRunId(request.params);
    await getAuthorizedAgentRun(runId, request.user.id);

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

    const unsubscribe = options.relay.subscribe(runId, (event) => {
      if (!reply.raw.destroyed) reply.raw.write(serializeSseEvent(event));
    });
    logger.info({ component: "agent-stream", event: "subscriber.connected", runId }, "Agent stream subscriber connected");
    const keepAlive = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": keep-alive\n\n");
    }, agentTaskConfig.streamKeepAliveMs);
    request.raw.once("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
      logger.info({ component: "agent-stream", event: "subscriber.disconnected", runId }, "Agent stream subscriber disconnected; run remains worker-owned");
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

function serializeSseEvent(event: AgentStreamEvent) {
  const { event: eventName, ...data } = event;
  return "event: " + eventName + "\n" + "data: " + JSON.stringify(data) + "\n\n";
}
