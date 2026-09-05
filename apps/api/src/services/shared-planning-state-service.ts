import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db/database.js";
import { agentTaskRuns, itineraryPlans } from "../db/schema.js";

/**
 * Where a trip stands on the road to a shared plan.
 *
 * This exists because the same predicate was written twice — once in the web
 * client's `canStartSharedPlanning` and once in the conversation handler's
 * `PersonalTripContext` — with a comment on the second begging it to keep
 * telling the same truth as the first. On 2026-09-05 they diverged in the way
 * duplicated predicates always do: the button vanished the moment a trip left
 * DRAFT, the prompt's authoritative handoff block went empty at the same
 * moment, and the assistant spent the rest of the trip's life telling the
 * traveller to press a button that was no longer on screen. Deriving it once,
 * on the server, is the fix for that class and not just that instance.
 *
 * The values are ordered by precedence, not by lifecycle: a replan running
 * over an existing plan is `IN_PROGRESS`, because what a caller wants to know
 * is whether to offer another run right now.
 */
export type SharedPlanningState =
  /** Still a Draft brief. The activation CTA owns the DRAFT→PLANNING write. */
  | "NOT_STARTED"
  /** A planning run is queued or running; offering another would double it. */
  | "IN_PROGRESS"
  /**
   * Activated, nothing in flight, and no plan to show. Either the run failed
   * or it completed with gaps and no itinerary. This is the state that had no
   * way out: the CTA was gone, the shared surface deliberately offers no
   * manual replan, and nothing else could start a run.
   */
  | "NO_PLAN_YET"
  /** A proposed or active plan exists; the shared surface has something to show. */
  | "PLAN_AVAILABLE";

const LIVE_RUN_STATUSES = ["QUEUED", "RUNNING", "CANCEL_REQUESTED"] as const;
const PLANNING_OPERATIONS = ["PLAN", "REPLAN", "RESEARCH"] as const;
/** STALE and SUPERSEDED are history: they are readable, not offerable. */
const USABLE_PLAN_STATUSES = ["PROPOSED", "ACTIVE"] as const;

export type SharedPlanningStateClient = typeof db | { select: typeof db.select };

/**
 * Derive the state for one trip. Two bounded reads, both trip-scoped; the
 * caller is responsible for having authorised the trip already.
 */
export async function loadSharedPlanningState(params: {
  tripId: string;
  tripStatus: string;
  client?: SharedPlanningStateClient;
}): Promise<SharedPlanningState> {
  if (params.tripStatus === "DRAFT") return "NOT_STARTED";
  const client = (params.client ?? db) as typeof db;

  const [liveRun] = await client.select({ id: agentTaskRuns.id })
    .from(agentTaskRuns)
    .where(and(
      eq(agentTaskRuns.tripId, params.tripId),
      inArray(agentTaskRuns.operation, [...PLANNING_OPERATIONS]),
      inArray(agentTaskRuns.status, [...LIVE_RUN_STATUSES]),
    ))
    .limit(1);
  if (liveRun) return "IN_PROGRESS";

  const [plan] = await client.select({ id: itineraryPlans.id })
    .from(itineraryPlans)
    .where(and(
      eq(itineraryPlans.tripId, params.tripId),
      inArray(itineraryPlans.status, [...USABLE_PLAN_STATUSES]),
    ))
    .limit(1);
  return plan ? "PLAN_AVAILABLE" : "NO_PLAN_YET";
}
