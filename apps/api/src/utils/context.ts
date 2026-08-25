import { randomUUID } from "node:crypto";

export interface RequestContext {
  correlationId: string;
  actorUserId?: string;
  traceId?: string;
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
): RequestContext {
  return {
    correlationId,
    actorUserId,
    traceId,
    clientRequestId,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    traceId: string;
  }
}
