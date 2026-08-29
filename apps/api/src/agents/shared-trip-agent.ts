import { registerSkill } from "./skill-registry.js";
import { planComparisonSkill } from "../skills/shared/plan-comparison-skill.js";
import { readinessSkill } from "../skills/shared/readiness-skill.js";
import { flightSearchSkill } from "../skills/shared/flight-search-skill.js";
import { placeSearchSkill } from "../skills/shared/place-search-skill.js";
import { tripPlaceSkill } from "../skills/shared/trip-place-skill.js";
import { navigationRouteSkill } from "../skills/shared/navigation-route-skill.js";
import { mobilitySearchSkill } from "../skills/shared/mobility-search-skill.js";
import { activitiesSearchSkill } from "../skills/shared/activities-search-skill.js";

export const sharedTripAgent = {
  name: "shared" as const,
  register(): void {
    registerSkill(planComparisonSkill);
    registerSkill(readinessSkill);
    registerSkill(flightSearchSkill);
    registerSkill(placeSearchSkill);
    registerSkill(tripPlaceSkill);
    registerSkill(navigationRouteSkill);
    registerSkill(mobilitySearchSkill);
    registerSkill(activitiesSearchSkill);
  },
};
