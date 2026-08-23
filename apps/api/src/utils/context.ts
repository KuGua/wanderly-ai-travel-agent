import { randomUUID } from "node:crypto";

export interface RequestContext {
  correlationId: string;
  actorUserId?: string;
  traceId?: string;
}

export function createRequestContext(actorUserId?: string): RequestContext {
  return {
    correlationId: randomUUID(),
    actorUserId,
    traceId: randomUUID(),
  };
}
