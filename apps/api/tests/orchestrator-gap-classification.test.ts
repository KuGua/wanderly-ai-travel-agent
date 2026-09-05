import { describe, expect, it } from "vitest";

import { SkillError } from "../src/agents/errors.js";
import { classifyError } from "../src/tasks/personal-trip-orchestrator-service.js";
import { serviceGapSchema } from "../src/services/planning-research-result-service.js";

/**
 * Trip 8a634324 on 2026-09-05 finished with `accommodation` and `places`
 * recorded as `UPSTREAM_FAILURE` while `provider_search_runs` held `LIVE` for
 * both and `provider_offers` held sixteen real stays. The skills had failed
 * their own output validation; nothing in "Output validation failed for
 * accommodation.discover" matched the substring classifier, so both fell
 * through to its `UPSTREAM_FAILURE` default and the surface blamed a supplier
 * that had done its job.
 */
describe("capability failure classification", () => {
  it("names a contract violation as ours, not the supplier's", () => {
    for (const code of ["OUTPUT_INVALID", "INPUT_INVALID", "SCHEMA_PARSE", "SKILL_VERSION_MISMATCH"] as const) {
      const err = new SkillError(code, `Output validation failed for accommodation.discover: ${code}`);
      expect(classifyError(err)).toBe("SKILL_CONTRACT_VIOLATION");
    }
  });

  it("classifies on the typed code rather than the message text", () => {
    // The message says "upstream"; the code says the request was refused for
    // want of authority. The code wins. This is the same failure as
    // docs/shared-agent-findings.md #21, where a quota message carrying
    // "limit: 25000" was read as a 5xx by a regex over the text.
    expect(classifyError(new SkillError("POLICY_DENIED", "upstream policy timeout rate")))
      .toBe("SEARCH_CONSTRAINTS_INCOMPLETE");
    expect(classifyError(new SkillError("RATE_LIMITED", "quota exhausted")))
      .toBe("RATE_LIMITED");
    expect(classifyError(new SkillError("TIMEOUT", "no keyword here")))
      .toBe("UPSTREAM_TIMEOUT");
  });

  it("still maps genuine supplier failures to a supplier code", () => {
    for (const code of ["NETWORK", "UPSTREAM_5XX", "UPSTREAM_FAILURE"] as const) {
      expect(classifyError(new SkillError(code, "boom"))).toBe("UPSTREAM_FAILURE");
    }
  });

  it("keeps the substring fallback for foreign errors", () => {
    expect(classifyError(new Error("connection timeout"))).toBe("UPSTREAM_TIMEOUT");
    expect(classifyError(new Error("provider is not configured"))).toBe("NOT_CONFIGURED");
    expect(classifyError("not an error at all")).toBe("UPSTREAM_FAILURE");
  });

  it("persists the internal code — a narrower gate would lose the outcome", () => {
    const parsed = serviceGapSchema.parse({
      capability: "accommodation",
      code: "SKILL_CONTRACT_VIOLATION",
    });
    expect(parsed.code).toBe("SKILL_CONTRACT_VIOLATION");
  });
});
