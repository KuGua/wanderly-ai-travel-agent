import type { AgentKind, PolicyGate, ResearchAuthority, SkillScope } from "./contracts.js";
import { SkillError } from "./errors.js";
import { isPersonalResearchCapabilityAllowed } from "../config/personal-research-allowed-capabilities.js";
import type { AgentTaskRow } from "../tasks/task-repository.js";

interface AgentScopePolicy {
  readonly personal: readonly SkillScope[];
  readonly shared: readonly SkillScope[];
  readonly review: readonly SkillScope[];
  readonly "public-content": readonly SkillScope[];
}

const DEFAULT_POLICY: AgentScopePolicy = {
  personal: [
    "profile:read",
    "profile:write:propose",
    "consent:read",
    "chat:read",
    // Phase 4: LLM-driven tool calling. The conversation worker builds the
    // `hotel.search` tool definition only when `PERSONAL_CONVERSATION_TOOL_DISPATCH_ENABLED`
    // is on, but the scope must be in the allow-list so the Personal Skill
    // can declare `allowedTools: ["chat:read", "hotel:search"]`. Owner-only
    // authority (`requirePersonalResearchAuthority`) still gates every
    // dispatch.
    "hotel:search",
  ],
  shared: [
    "snapshot:read",
    "plan:write:propose",
    "readiness:read",
    "flight:search",
    "hotel:search",
    "accommodation:discover",
    "activities:search",
    "places:search",
    "places:adopt",
    "navigation:route",
    "mobility:search",
  ],
  // Per docs/agent-architecture.md §3 + §5, the review agent is a read-only
  // critic. It must never write plans; when the `PlanReviewSkill` lands it
  // will inherit this scope. The previous `"plan:write:propose"` entry was
  // a dormant over-permission that `apps/api/src/skills/REVIEW.md` mirrored
  // and that `npm run docs:verify` pinned against the source — both are
  // narrowed here in lockstep (see §3.4 of the planner-resilience design).
  review: ["snapshot:read"],
  // S4: public-content agents run the cached location-introduction skill
  // and have no access to Profile/Trip/thread/snapshot data. Empty by
  // design — they only call ModelGateway.generateLocationContent.
  "public-content": [],
};

export class DefaultPolicyGate implements PolicyGate {
  constructor(private readonly agentKind: AgentKind) {}

  requireScope(scopes: readonly SkillScope[]): void {
    const allowed = DEFAULT_POLICY[this.agentKind];
    const offending = scopes.find(scope => !allowed.includes(scope));
    if (offending) {
      throw new Error(`Scope ${offending} is not allowed for ${this.agentKind}`);
    }
  }

  /**
   * Single source of truth for "is this scope a write". Used by both this
   * gate and by `apps/api/src/agents/skill-registry.ts` (P1-A) to refuse
   * `skill.retry` declarations on side-effecting skills at registration
   * time. A scope counts as a write if it equals the `bookings` root or
   * ends with `:write` / `:write:propose` / `:adopt` (the last catches
   * `places:adopt`, the only mutable POI scope in the registry).
   */
  static isWriteScope(scope: SkillScope): boolean {
    return scope === "bookings"
      || scope === "places:adopt"
      || scope.endsWith(":write")
      || scope.endsWith(":write:propose");
  }

  /**
   * Owner-only PERSONAL_RESEARCH authority gate. Throws `SkillError("POLICY_DENIED")`
   * unless the supplied authority is structurally valid AND the capability is
   * currently allowed by `PERSONAL_RESEARCH_ALLOWED_CAPABILITIES`.
   *
   * Source: docs/draft-personal-research-implementation.md §3.1.
   */
  requirePersonalResearchAuthority(authority: ResearchAuthority, run: AgentTaskRow): void {
    if (authority.kind !== "PERSONAL") {
      throw new SkillError(
        "POLICY_DENIED",
        `Personal research authority kind mismatch: expected PERSONAL, got ${authority.kind}`,
      );
    }
    if (!isPersonalResearchCapabilityAllowed(authority.capability)) {
      throw new SkillError(
        "POLICY_DENIED",
        `Personal research capability not enabled: ${authority.capability}`,
      );
    }
    if (run.createdByUserId !== authority.ownerUserId) {
      throw new SkillError("POLICY_DENIED", "Personal research run owner mismatch");
    }
    if (run.tripId !== authority.tripId) {
      throw new SkillError("POLICY_DENIED", "Personal research run trip mismatch");
    }
    if (run.threadId !== authority.threadId) {
      throw new SkillError("POLICY_DENIED", "Personal research run thread mismatch");
    }
    if (run.snapshotId !== null) {
      throw new SkillError("POLICY_DENIED", "Personal research run must not carry a snapshot");
    }
  }
}
