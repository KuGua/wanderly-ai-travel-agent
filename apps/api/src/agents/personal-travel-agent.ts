import { registerSkill } from "./skill-registry.js";
import { profileMemorySkill } from "../skills/personal/profile-memory-skill.js";
import { profileChangeProposalSkill } from "../skills/personal/profile-change-proposal-skill.js";
import { consentExplanationSkill } from "../skills/personal/consent-explanation-skill.js";
import { threadRecallSkill } from "../skills/personal/thread-recall-skill.js";
import { travelConversationSkill } from "../skills/personal/travel-conversation-skill.js";

export const personalTravelAgent = {
  name: "personal" as const,
  register(): void {
    registerSkill(profileMemorySkill);
    registerSkill(profileChangeProposalSkill);
    registerSkill(consentExplanationSkill);
    registerSkill(threadRecallSkill);
    registerSkill(travelConversationSkill);
  },
};
