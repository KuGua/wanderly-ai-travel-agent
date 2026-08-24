import { randomUUID } from "node:crypto";

export interface RequestContext {
  correlationId: string;
  actorUserId?: string;
  traceId?: string;
}

export function createRequestContext(
  actorUserId?: string,
  correlationId: string = randomUUID(),
  traceId: string = randomUUID(),
): RequestContext {
  return {
    correlationId,
    actorUserId,
    traceId,
  };
}

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
    traceId: string;
  }
}
