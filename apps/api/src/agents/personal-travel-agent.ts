import { registerSkill } from "./skill-registry.js";
import { profileMemorySkill } from "../skills/personal/profile-memory-skill.js";
import { profileChangeProposalSkill } from "../skills/personal/profile-change-proposal-skill.js";
import { consentExplanationSkill } from "../skills/personal/consent-explanation-skill.js";
import { threadRecallSkill } from "../skills/personal/thread-recall-skill.js";
import { travelConversationSkill } from "../skills/personal/travel-conversation-skill.js";
import { tripConstraintProposeSkill } from "../skills/personal/trip-constraint-propose-skill.js";
import { threadTitleSuggestSkill } from "../skills/personal/thread-title-suggest-skill.js";
import { tripDestinationLabelSuggestSkill } from "../skills/personal/trip-destination-label-suggest-skill.js";
import { destinationCueDecisionSkill } from "../skills/personal/destination-cue-decision-skill.js";

export const personalTravelAgent = {
  name: "personal" as const,
  register(): void {
    registerSkill(profileMemorySkill);
    registerSkill(profileChangeProposalSkill);
    registerSkill(consentExplanationSkill);
    registerSkill(threadRecallSkill);
    registerSkill(travelConversationSkill);
    registerSkill(tripConstraintProposeSkill);
    registerSkill(threadTitleSuggestSkill);
    registerSkill(tripDestinationLabelSuggestSkill);
    registerSkill(destinationCueDecisionSkill);
  },
};
