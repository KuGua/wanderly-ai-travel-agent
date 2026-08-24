import { db } from "../db/database.js";
import { auditEvents } from "../db/schema.js";
import type { RequestContext } from "../utils/context.js";

export type AuditAction =
  | "PROFILE_CREATE" | "PROFILE_UPDATE" | "PROFILE_DELETE"
  | "TRIP_CREATE" | "TRIP_JOIN"
  | "CONSENT_GRANT" | "CONSENT_REVOKE"
  | "PLAN_CREATE" | "PLAN_STALE" | "PLAN_REPLAN"
  | "CONFIRMATION_SET"
  | "BOOKING_SUBMIT" | "BOOKING_RESULT"
  | "CHANGE_EVENT"
  | "SKILL_INVOKE" | "AGENT_RUN";

export async function recordAudit(params: {
  ctx: RequestContext;
  action: AuditAction;
  actorUserId?: string;
  tripId?: string;
  planId?: string;
  summary?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditEvents).values({
    correlationId: params.ctx.correlationId,
    action: params.action,
    actorUserId: params.actorUserId ?? params.ctx.actorUserId,
    tripId: params.tripId,
    planId: params.planId,
    summary: params.summary ?? {},
  });
}
