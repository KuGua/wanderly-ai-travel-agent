import { and, eq } from "drizzle-orm";

import { db } from "../../db/database.js";
import { constraintSnapshots, tripMembers } from "../../db/schema.js";
import { generatePlan } from "../../services/planning-service.js";
import type { RequestContext } from "../../utils/context.js";
import type { AgentTaskRow } from "../task-repository.js";

/** Runs only from the durable Worker.  All authority comes from the accepted
 * task row and immutable snapshot; no browser/model fields are consulted. */
export async function handlePlanningTask(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
  signal: AbortSignal;
  leaseToken: string;
}): Promise<string> {
  const { run } = params;
  if ((run.operation !== "PLAN" && run.operation !== "REPLAN") || !run.tripId || !run.snapshotId
    || !run.flightSearchPreferencesVersion) throw new Error("Planning task authority is incomplete");
  const [member] = await db.select({ userId: tripMembers.userId }).from(tripMembers).where(and(
    eq(tripMembers.tripId, run.tripId), eq(tripMembers.userId, run.createdByUserId),
  )).limit(1);
  if (!member) throw Object.assign(new Error("Planning requester is no longer a trip member"), { code: "POLICY_DENIED" });
  const [snapshot] = await db.select().from(constraintSnapshots).where(and(
    eq(constraintSnapshots.id, run.snapshotId), eq(constraintSnapshots.tripId, run.tripId),
  )).limit(1);
  if (!snapshot) throw Object.assign(new Error("Planning snapshot is unavailable"), { code: "POLICY_DENIED" });
  const candidates = snapshot.destinationCandidates as string[];
  if (candidates.length === 0) throw Object.assign(new Error("Planning snapshot has no destinations"), { code: "PLANNING_DATA_UNAVAILABLE" });
  const destination = candidates[0];
  if (params.signal.aborted) throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
  const resultPlanId = await generatePlan({
      ctx: params.ctx, tripId: run.tripId, snapshotId: run.snapshotId,
      destination, memberIds: [], agentTaskRunId: run.id,
      flightSearchPreferencesVersion: run.flightSearchPreferencesVersion,
      signal: params.signal,
      leaseToken: params.leaseToken,
    });
  return resultPlanId;
}
