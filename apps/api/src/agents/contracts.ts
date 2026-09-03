import type { z } from "zod";
import type { RequestContext } from "../utils/context.js";
import type { ConstraintSnapshotData, PersonalResearchOperationCapability } from "../types/domain.js";
import type { HotelProviderName, HotelProvider } from "../providers/types.js";
import type { SkillErrorCode } from "./errors.js";

export type AgentKind = "personal" | "shared" | "review" | "public-content";

export type SkillScope =
  | "profile:read"
  | "profile:write:propose"
  | "consent:read"
  | "plan:write:propose"
  | "readiness:read"
  | "bookings"
  | "snapshot:read"
  | "chat:read"
  | "flight:search"
  | "hotel:search"
  | "accommodation:discover"
  | "activities:search"
  | "places:search"
  | "places:adopt"
  | "navigation:route"
  | "mobility:search";

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
 * Server-derived authorization data for a Shared `places.search` invocation.
 * The model is never asked to produce this; the planner service builds it
 * from the run-bound task row.
 */
export interface PlaceSearchExecutionContext {
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
}

export interface NavigationRouteExecutionContext {
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
}

export interface MobilitySearchExecutionContext {
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
}

/**
 * Server-derived authorization data for a Shared `activities.search`
 * invocation. The browser and model cannot provide these bindings.
 */
export interface ActivitySearchExecutionContext {
  tripId: string;
  snapshotId: string;
  /**
   * Currency the provider must price in, from the trip's confirmed search
   * preferences. Server-owned: the model never chooses it, and without it a
   * returned amount has no known denomination.
   */
  currency: string;
  agentTaskRunId?: string;
}

export interface HotelSearchExecutionContext {
  tripId: string;
  snapshotId: string;
  searchPreferencesVersion: number;
  searchPreferences: {
    roomCount: number;
    adultsPerRoom: number[];
    currency: string;
  };
  locale: "en" | "zh";
  /**
   * Provider that this task is bound to. The skill handler MUST use this
   * value (not a module-load singleton) so a config reload after acceptance
   * never changes the source for an in-flight task. Spec §3.1.
   */
  provider: HotelProviderName;
  /**
   * The actual adapter instance resolved for `provider`. The planner service
   * selects it once at acceptance time and threads it through the skill so
   * the handler never has to consult the env or the factory registry.
   */
  providerAdapter: HotelProvider;
  /**
   * When `provider === "nuitee_connect"`, this carries the active quote
   * nationality authorization id/version so the skill can resolve the
   * plaintext server-side and pass it to the adapter. `undefined` when
   * the provider does not require any user-confirmed field.
   */
  quoteNationalityAuthorization?: { id: string; version: number };
  agentTaskRunId?: string;
}

export interface AccommodationDiscoveryExecutionContext {
  tripId: string;
  snapshotId: string;
  agentTaskRunId?: string;
}

/**
 * Policy gate consulted by the registry before invoking a skill. Implementations
 * are responsible for enforcing per-agent tool/scope rules.
 */
export interface PolicyGate {
  requireScope(scopes: readonly SkillScope[]): void;
  /**
   * Owner-only PERSONAL_RESEARCH authority gate. Throws `SkillError("POLICY_DENIED")`
   * unless the supplied authority is structurally valid AND the capability is
   * currently allowed. See apps/api/src/config/personal-research-allowed-capabilities.ts.
   * Source: docs/draft-personal-research-implementation.md §3.1.
   */
  requirePersonalResearchAuthority(authority: ResearchAuthority, run: AgentTaskRowLike): void;
}

/**
 * Discriminated authority built server-side at the handler and reused by the
 * Personal Research executor. Personal Research carries the run's owner,
 * thread, and trip bindings; never a `snapshotId`. Shared Research keeps its
 * snapshot-bound shape so the two paths cannot be confused at policy time.
 */
export type ResearchAuthority =
  | {
      kind: "PERSONAL";
      tripId: string;
      threadId: string;
      ownerUserId: string;
      runId: string;
      capability: PersonalResearchOperationCapability;
    }
  | {
      kind: "SHARED";
      tripId: string;
      snapshotId: string;
      runId: string;
    };

/**
 * Structural subset of `agent_task_runs` consulted by `PolicyGate.requirePersonalResearchAuthority`.
 * Defined as a structural interface to avoid a circular type import
 * (task-repository → policy-gate → task-repository).
 */
export interface AgentTaskRowLike {
  id: string;
  createdByUserId: string;
  tripId: string | null;
  threadId: string | null;
  snapshotId: string | null;
  operation: string;
}

export interface SkillContext {
  ctx: RequestContext;
  snapshot?: ConstraintSnapshotData;
  flightSearch?: FlightSearchExecutionContext;
  placeSearch?: PlaceSearchExecutionContext;
  navigation?: NavigationRouteExecutionContext;
  mobility?: MobilitySearchExecutionContext;
  activitiesSearch?: ActivitySearchExecutionContext;
  hotelSearch?: HotelSearchExecutionContext;
  accommodationDiscovery?: AccommodationDiscoveryExecutionContext;
  policyGate: PolicyGate;
}

/**
 * Optional retry policy for an individual Skill invocation. Per
 * `docs/planner-resilience-and-reflection-implementation.md` §4.2, retry only
 * applies to side-effect-free read paths — the registry enforces that at
 * registration time by inspecting `skill.allowedTools`. Absent (default) →
 * single attempt with `skill.timeoutMs`, exactly matching pre-P1 behaviour.
 */
export interface SkillRetryPolicy {
  /**
   * Inclusive upper bound on total attempts (the original attempt counts
   * as one). Range `1..3`. Values outside this range are rejected at
   * registration time so adapters cannot accidentally opt in to unbounded
   * retry loops.
   */
  readonly maxAttempts: number;
  /**
   * Subset of `SkillErrorCode` that warrants a retry. Anything not listed
   * is treated as non-retryable: `INPUT_INVALID`, `OUTPUT_INVALID`,
   * `POLICY_DENIED`, `TOOL_NOT_ALLOWED`, `SCHEMA_PARSE`, and caller-initiated
   * aborts never retry — that distinction is the whole point of the field.
   */
  readonly retryOn: readonly SkillErrorCode[];
  /** Base delay for non-rate-limit retries; doubled per attempt. */
  readonly backoffBaseMs: number;
  /**
   * Fixed delay for `RATE_LIMITED` retries. Uses its own clock (no
   * exponential backoff) per `isRetryableUpstreamError` discipline.
   */
  readonly rateLimitedDelayMs: number;
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
  /**
   * Optional retry policy. Omit (or set `undefined`) for single-attempt
   * execution — the default — which preserves pre-P1 behaviour exactly.
   * The registry refuses to register a Skill that declares `retry` together
   * with any write scope (see `DefaultPolicyGate.isWriteScope` and the
   * registration-time guard in `skill-registry.ts`).
   */
  retry?: SkillRetryPolicy;
  handler: (ctx: SkillContext, input: I, signal: AbortSignal) => Promise<O>;
}

export interface SkillInvocationRecord {
  skillName: string;
  version: string;
  outputHash: string;
  latencyMs: number;
  /**
   * Total attempts the registry took to produce this record (1 for
   * single-attempt Skills, 2+ when `retry` is declared and at least one
   * retry was attempted). Surfaced in `SKILL_INVOKE` audit summaries so
   * observability can distinguish "succeeded first try" from "succeeded
   * after a retry".
   */
  attempts: number;
  status: "SUCCESS" | "TIMEOUT" | "OUTPUT_INVALID";
}
