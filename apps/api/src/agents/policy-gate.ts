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
  review: ["snapshot:read", "plan:write:propose"],
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
