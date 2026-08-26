import { db } from "../db/database.js";
import { auditEvents } from "../db/schema.js";
import type { RequestContext } from "../utils/context.js";

// Drizzle transaction callback parameter type. Aliased for readability.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AuditAction =
  | "PROFILE_CREATE" | "PROFILE_UPDATE" | "PROFILE_DELETE"
  | "TRIP_CREATE" | "TRIP_JOIN"
  | "CONSENT_GRANT" | "CONSENT_REVOKE"
  | "PLAN_CREATE" | "PLAN_STALE" | "PLAN_REPLAN" | "PLAN_RESTART"
  | "CONFIRMATION_SET"
  | "BOOKING_SUBMIT" | "BOOKING_RESULT"
  | "CHANGE_EVENT"
  | "VISA_CHECK"
  | "CHAT_THREAD_CREATE" | "CHAT_THREAD_DELETE" | "CHAT_MESSAGE_APPEND"
  | "SKILL_INVOKE" | "AGENT_RUN" | "AGENT_TASK";

export type AuditSummaryValue = string | number | boolean | null | AuditSummaryValue[] | {
  [key: string]: AuditSummaryValue;
};

const MAX_SUMMARY_DEPTH = 3;
const UNSAFE_SUMMARY_KEY = /(?:password|secret|token|credential|authorization|cookie|passport|documentNumber|dateOfBirth|nationality|rawBody|requestBody|prompt|conversation|privateMessage|payload)/i;

export class AuditSummaryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditSummaryValidationError";
  }
}

/**
 * Copies an audit summary only when every value satisfies the persistent audit
 * contract. Root depth is zero; arrays and nested plain objects count as one
 * structure level, and structures deeper than three are rejected.
 */
export function whitelistSummary(value: unknown): AuditSummaryValue {
  return validateSummaryValue(value, 0, new WeakSet<object>());
}

function validateSummaryValue(value: unknown, depth: number, seen: WeakSet<object>): AuditSummaryValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuditSummaryValidationError("Audit summary numbers must be finite");
    return value;
  }
  if (typeof value !== "object") {
    throw new AuditSummaryValidationError(`Unsupported audit summary value: ${typeof value}`);
  }
  if (depth > MAX_SUMMARY_DEPTH) {
    throw new AuditSummaryValidationError(`Audit summary exceeds maximum depth ${MAX_SUMMARY_DEPTH}`);
  }
  if (seen.has(value)) throw new AuditSummaryValidationError("Audit summary cannot contain cycles");
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => validateSummaryValue(item, depth + 1, seen));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AuditSummaryValidationError("Audit summary objects must use the plain Object prototype");
  }

  const output: Record<string, AuditSummaryValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_SUMMARY_KEY.test(key)) {
      throw new AuditSummaryValidationError(`Unsafe audit summary key: ${key}`);
    }
    output[key] = validateSummaryValue(item, depth + 1, seen);
  }
  return output;
}

export async function recordAudit(params: {
  ctx: RequestContext;
  action: AuditAction;
  actorUserId?: string;
  tripId?: string;
  planId?: string;
  summary?: Record<string, unknown>;
  /** Optional transaction handle so the audit row commits atomically with
   * the business state change. Defaults to the global `db`. */
  tx?: Tx;
}): Promise<void> {
  const sanitized = whitelistSummary(params.summary ?? {}) as Record<string, AuditSummaryValue>;
  const target = params.tx ?? db;

  await target.insert(auditEvents).values({
    correlationId: params.ctx.correlationId,
    action: params.action,
    actorUserId: params.actorUserId ?? params.ctx.actorUserId,
    tripId: params.tripId,
    planId: params.planId,
    summary: sanitized,
  });
}
