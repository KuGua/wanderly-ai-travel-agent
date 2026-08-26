import { randomUUID } from "node:crypto";

export interface RequestContext {
  correlationId: string;
  actorUserId?: string;
  /**
   * W3C trace id (32 lowercase hex chars). Distinct from `correlationId`:
   * `correlationId` is the canonical server-owned UUID used for logs and
   * audit; `traceId` is the OTel trace id carried in `traceparent` for
   * distributed tracing. They are bound 1:1 at the inbound HTTP boundary.
   */
  traceId?: string;
  /**
   * W3C span id (16 lowercase hex chars) for the active inbound HTTP server
   * span. Set alongside `traceId` by the API onRequest hook. Workers
   * reconstruct it from the persisted `agent_task_runs.trace_context`
   * column.
   */
  spanId?: string;
  /**
   * Full W3C `traceparent` header value (`00-<traceId>-<spanId>-<flags>`).
   * Forwarded verbatim to outbound LLM and DB callers via the OpenTelemetry
   * text-map propagator.
   */
  traceparent?: string;
  /**
   * Optional W3C `tracestate` header value. Carries vendor-specific trace
   * data alongside `traceparent`; the OTel SDK treats it as a passthrough.
   */
  tracestate?: string;
  /**
   * Client-supplied request id (from `X-Request-Id`). The server's
   * `correlationId` remains authoritative; `clientRequestId` is propagated
   * into logs/audit so the browser session can be correlated with the
   * server log thread.
   */
  clientRequestId?: string;
}

export function createRequestContext(
  actorUserId?: string,
  correlationId: string = randomUUID(),
  traceId: string = randomUUID(),
  clientRequestId?: string,
  traceparent?: string,
  tracestate?: string,
  spanId?: string,
): RequestContext {
  return {
    correlationId,
    actorUserId,
    traceId,
    spanId,
    traceparent,
    tracestate,
    clientRequestId,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    traceId: string;
    spanId: string;
    traceparent?: string;
    tracestate?: string;
  }
}
