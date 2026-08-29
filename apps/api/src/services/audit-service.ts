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
  | "TRIP_INVITATION_CREATE" | "TRIP_INVITATION_ACCEPT"
  | "TRIP_INVITATION_REVOKE" | "TRIP_DEFAULT_THREAD_PROVISION"
  | "EXPLORATION_START" | "TRIP_ACTIVATE" | "TRIP_TITLE_UPDATE" | "TRIP_DRAFT_BRIEF_UPDATE"
  | "SKILL_INVOKE" | "AGENT_RUN" | "AGENT_TASK"
  | "FLIGHT_SEARCH_REQUESTED" | "FLIGHT_SEARCH_COMPLETED" | "FLIGHT_SEARCH_UNAVAILABLE"
  | "ACTIVITIES_SEARCH_REQUESTED" | "ACTIVITIES_SEARCH_COMPLETED" | "ACTIVITIES_SEARCH_UNAVAILABLE"
  // Phase 2 / Team Agent 协作编排 (added via 0021_team_orchestration_enums.sql):
  | "TRIP_CONSTRAINT_PROPOSED"
  | "TRIP_CONSTRAINT_CONFIRMED"
  | "TRIP_CONSTRAINT_REVOKED"
  | "PLAN_REPLAN_ENQUEUED"
  | "PLAN_ADOPTION_VOTED"
  | "PLAN_ADOPTED"
  // Global POI & ground mobility (added via 0023_poi_route_mobility.sql):
  | "PLACE_SEARCH_REQUESTED"
  | "PLACE_SEARCH_COMPLETED"
  | "PLACE_SEARCH_UNAVAILABLE"
  | "NAVIGATION_ROUTE_REQUESTED"
  | "NAVIGATION_ROUTE_COMPLETED"
  | "NAVIGATION_ROUTE_UNAVAILABLE"
  | "MOBILITY_OFFER_REQUESTED"
  | "MOBILITY_OFFER_COMPLETED"
  | "MOBILITY_OFFER_UNAVAILABLE"
  | "TRIP_PLACE_PROPOSED"
  | "TRIP_PLACE_ADOPTED"
  | "TRIP_PLACE_REVOKED"
  | "RESEARCH_RESULT_RECORDED";

export type AuditSummaryValue = string | number | boolean | null | AuditSummaryValue[] | {
  [key: string]: AuditSummaryValue;
};

const MAX_SUMMARY_DEPTH = 3;
const UNSAFE_SUMMARY_KEY = /(?:password|secret|token|credential|authorization|cookie|passport|documentNumber|dateOfBirth|nationality|rawBody|requestBody|prompt|conversation|privateMessage|payload|valueJson|orchestratorConfidential|projectionManifest)/i;

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
