import { describe, expect, it } from "vitest";
import {
  SHARED_STRUCTURED_PLANNING_SYSTEM_PROMPT,
  SHARED_TOOL_PLANNING_SYSTEM_PROMPT,
} from "../src/providers/shared-planning-prompts.js";

/**
 * Spec §2.2: the model must receive the one-to-one category-to-slot
 * contract on the first turn so the repair loop does not have to spend a
 * turn explaining it. The runtime system-message injection in
 * `llm-gateway.ts` is the second line of defence; the system prompt is
 * the first. A regression here could re-open the retired `stays` field and
 * its hotel-in-stays failure mode.
 */
const SLOT_CONTRACT_SENTINEL = "Each id you select must reference an entry from the SAME category";

describe("shared-planning system prompts", () => {
  it("structured prompt states the category-to-slot contract on the first turn", () => {
    expect(SHARED_STRUCTURED_PLANNING_SYSTEM_PROMPT).toContain(SLOT_CONTRACT_SENTINEL);
  });

  it("tool prompt states the category-to-slot contract on the first turn", () => {
    expect(SHARED_TOOL_PLANNING_SYSTEM_PROMPT).toContain(SLOT_CONTRACT_SENTINEL);
  });

  it("both prompts retire stays and preserve the priced/discovery accommodation boundary", () => {
    for (const prompt of [SHARED_STRUCTURED_PLANNING_SYSTEM_PROMPT, SHARED_TOOL_PLANNING_SYSTEM_PROMPT]) {
      expect(prompt).toContain("`stays` is retired");
      expect(prompt).toContain("`hotels` and `accommodations` are distinct");
    }
  });
});
