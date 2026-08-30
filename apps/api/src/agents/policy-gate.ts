import type { AgentKind, PolicyGate, SkillScope } from "./contracts.js";

interface AgentScopePolicy {
  readonly personal: readonly SkillScope[];
  readonly shared: readonly SkillScope[];
  readonly review: readonly SkillScope[];
  readonly "public-content": readonly SkillScope[];
}

const DEFAULT_POLICY: AgentScopePolicy = {
  personal: ["profile:read", "profile:write:propose", "consent:read", "chat:read"],
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
}
