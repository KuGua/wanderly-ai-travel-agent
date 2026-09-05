import { describe, expect, it } from "vitest";

import { agentTaskConfig } from "../src/tasks/config.js";
import { travelConversationSkill } from "../src/skills/personal/travel-conversation-skill.js";
import { CONVERSATION_TURN_HARD_CAP_MS } from "../src/tasks/handlers/conversation-task-handler.js";

describe("the conversation model budget", () => {
  // It was a literal 15_000 on the skill. Two consecutive turns measured on
  // 2026-09-05 each spent 15.0s of pure model time — the first finished on the
  // line, the second was aborted and surfaced the degraded "can't reach the
  // conversation model" notice. Operators need to raise this without a code
  // change, so the wiring, not just the number, is what this locks down.
  it("comes from configuration rather than a literal on the skill", () => {
    expect(travelConversationSkill.timeoutMs).toBe(agentTaskConfig.conversationModelBudgetMs);
  });

  it("defaults to 30s — double the ceiling that was being hit", () => {
    expect(agentTaskConfig.conversationModelBudgetMs).toBe(30_000);
  });

  // `createTurnDeadline` runs the model budget and the tool budget on separate
  // clocks, so the worst case a traveller can wait is their sum. It has to stay
  // clear of the hard cap or the cap, not the budget, becomes what fires.
  it("leaves room under the turn hard cap once the tool budget is spent", () => {
    const worstCase = agentTaskConfig.conversationModelBudgetMs
      + agentTaskConfig.conversationToolBudgetMs;
    expect(worstCase).toBeLessThan(CONVERSATION_TURN_HARD_CAP_MS);
  });
});
