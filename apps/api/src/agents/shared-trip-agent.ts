import { registerSkill } from "./skill-registry.js";
import { planComparisonSkill } from "../skills/shared/plan-comparison-skill.js";
import { readinessSkill } from "../skills/shared/readiness-skill.js";
import { flightSearchSkill } from "../skills/shared/flight-search-skill.js";

export const sharedTripAgent = {
  name: "shared" as const,
  register(): void {
    registerSkill(planComparisonSkill);
    registerSkill(readinessSkill);
    registerSkill(flightSearchSkill);
  },
};
