import { registerSkill } from "./skill-registry.js";
import { profileMemorySkill } from "../skills/personal/profile-memory-skill.js";
import { profileChangeProposalSkill } from "../skills/personal/profile-change-proposal-skill.js";
import { consentExplanationSkill } from "../skills/personal/consent-explanation-skill.js";

export const personalTravelAgent = {
  name: "personal" as const,
  register(): void {
    registerSkill(profileMemorySkill);
    registerSkill(profileChangeProposalSkill);
    registerSkill(consentExplanationSkill);
  },
};