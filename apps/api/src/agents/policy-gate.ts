import type { AgentKind, PolicyGate, SkillScope } from "./contracts.js";

interface AgentScopePolicy {
  readonly personal: readonly SkillScope[];
  readonly shared: readonly SkillScope[];
  readonly review: readonly SkillScope[];
}

const DEFAULT_POLICY: AgentScopePolicy = {
  personal: ["profile:read", "profile:write:propose", "consent:read"],
  shared: ["snapshot:read", "plan:write:propose", "readiness:read"],
  review: ["snapshot:read", "plan:write:propose"],
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