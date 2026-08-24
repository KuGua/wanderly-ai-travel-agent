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
  | "snapshot:read";

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