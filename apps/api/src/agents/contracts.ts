import type { z } from "zod";
import type { RequestContext } from "../utils/context.js";
import type { ConstraintSnapshotData } from "../types/domain.js";

export type AgentKind = "personal" | "shared" | "review";

export type SkillScope =
  | "profile:read"
  | "profile:write:propose"
  | "consent:read"
  | "plan:write:propose"
  | "readiness:read"
  | "bookings"
  | "snapshot:read"
  | "chat:read"
  | "flight:search";

/**
 * Server-derived authorization data for a Shared flight-search invocation.
 * It is never accepted from a browser or model and is deliberately separate
 * from the immutable snapshot's sensitive authorized member data.
 */
export interface FlightSearchExecutionContext {
  tripId: string;
  snapshotId: string;
  searchPreferencesVersion: number;
  searchPreferences: {
    tripType: "ONE_WAY" | "ROUND_TRIP";
    adults: number;
    cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
    currency: string;
  };
  agentTaskRunId?: string;
}

/**
 * Policy gate consulted by the registry before invoking a skill. Implementations
 * are responsible for enforcing per-agent tool/scope rules.
 */
export interface PolicyGate {
  requireScope(scopes: readonly SkillScope[]): void;
}

export interface SkillContext {
  ctx: RequestContext;
  snapshot?: ConstraintSnapshotData;
  flightSearch?: FlightSearchExecutionContext;
  policyGate: PolicyGate;
}

export interface Skill<I, O> {
  name: string;
  agent: AgentKind;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  allowedTools: readonly SkillScope[];
  timeoutMs: number;
  needsConfirm: boolean;
  version: string;
  handler: (ctx: SkillContext, input: I, signal: AbortSignal) => Promise<O>;
}

export interface SkillInvocationRecord {
  skillName: string;
  version: string;
  outputHash: string;
  latencyMs: number;
  status: "SUCCESS" | "TIMEOUT" | "OUTPUT_INVALID";
}
