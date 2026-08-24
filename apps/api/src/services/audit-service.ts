import { db } from "../db/database.js";
import { auditEvents } from "../db/schema.js";
import type { RequestContext } from "../utils/context.js";
import { redact } from "../observability/redaction.js";

export type AuditAction =
  | "PROFILE_CREATE" | "PROFILE_UPDATE" | "PROFILE_DELETE"
  | "TRIP_CREATE" | "TRIP_JOIN"
  | "CONSENT_GRANT" | "CONSENT_REVOKE"
  | "PLAN_CREATE" | "PLAN_STALE" | "PLAN_REPLAN"
  | "CONFIRMATION_SET"
  | "BOOKING_SUBMIT" | "BOOKING_RESULT"
  | "CHANGE_EVENT"
  | "SKILL_INVOKE" | "AGENT_RUN";

/**
 * Whitelist filter applied to every audit summary before it lands in the
 * database. Removes any nested key matching the PII regex and clamps recursion
 * depth so that malformed values cannot smuggle unbounded payloads.
 */
export function whitelistSummary(value: unknown, depth: number = 3): unknown {
  return redact(value, { depth });
}

export async function recordAudit(params: {
  ctx: RequestContext;
  action: AuditAction;
  actorUserId?: string;
  tripId?: string;
  planId?: string;
  summary?: Record<string, unknown>;
}): Promise<void> {
  const sanitized = whitelistSummary(params.summary ?? {}) as Record<string, unknown>;

  await db.insert(auditEvents).values({
    correlationId: params.ctx.correlationId,
    action: params.action,
    actorUserId: params.actorUserId ?? params.ctx.actorUserId,
    tripId: params.tripId,
    planId: params.planId,
    summary: sanitized,
  });
}