import { and, eq } from "drizzle-orm";

import { db } from "../../db/database.js";
import {
  constraintSnapshots,
  itineraryPlans,
  tripConstraintFacts,
  tripMembers,
} from "../../db/schema.js";
import { generatePlan } from "../../services/planning-service.js";
import { assertSnapshotManifestStable, hashProjectionManifest } from "../../services/snapshot-manifest-guard.js";
import type { RequestContext } from "../../utils/context.js";
import { logSafeRuntimeEvent } from "../../observability/telemetry.js";
import type { AgentTaskRow } from "../task-repository.js";
import { handleResearchTask } from "./research-task-handler.js";
import { handlePersonalResearchTask } from "./personal-research-task-handler.js";

/** Runs only from the durable Worker.  All authority comes from the accepted
 * task row and immutable snapshot; no browser/model fields are consulted. */
export async function handlePlanningTask(params: {
  run: AgentTaskRow;
  ctx: RequestContext;
  signal: AbortSignal;
  leaseToken: string;
}): Promise<string> {
  const { run } = params;

  // PERSONAL_RESEARCH (added via 0047a) is dispatched through the same
  // Worker lease / cancellation / SSE plumbing as PLAN/REPLAN/RESEARCH,
  // but it has its own owner-only handler that does not call generatePlan
  // and never touches Shared snapshots. Spec §3.3.
  if (run.operation === "PERSONAL_RESEARCH") {
    const result = await handlePersonalResearchTask(params);
    return result ?? "";
  }

  // Phase 2 — Personal Trip Orchestrator. RESEARCH is dispatched through the
  // same Worker lease / cancellation / SSE plumbing as PLAN/REPLAN, but it
  // has its own handler that does NOT call generatePlan in Phase 2 (Phase 4
  // wires PROPOSE_PLAN into the planner). Returning early here keeps the
  // legacy planner logic untouched.
  if (run.operation === "RESEARCH") {
    return (await handleResearchTask(params)) ?? "";
  }

  const startedAt = Date.now();
  logSafeRuntimeEvent(params.ctx, {
    component: "planner", event: "task", operation: run.operation.toLowerCase(), outcome: "started",
    attempt: run.generationAttempt, relatedRunId: run.id, relatedSnapshotId: run.snapshotId ?? undefined,
  });
  if (
    (run.operation !== "PLAN" && run.operation !== "REPLAN")
    || !run.tripId || !run.snapshotId || !run.flightSearchPreferencesVersion
  ) {
    throw new Error("Planning task authority is incomplete");
  }
  if (process.env.PLAN_ENABLE_HOTEL === "true" && !run.staySearchPreferencesVersion) {
    throw new Error("Planning task stay-search authority is incomplete");
  }
  const [member] = await db.select({ userId: tripMembers.userId }).from(tripMembers).where(and(
    eq(tripMembers.tripId, run.tripId), eq(tripMembers.userId, run.createdByUserId),
  )).limit(1);
  if (!member) {
    throw Object.assign(new Error("Planning requester is no longer a trip member"), { code: "POLICY_DENIED" });
  }

  const [snapshot] = await db.select().from(constraintSnapshots).where(and(
    eq(constraintSnapshots.id, run.snapshotId),
    eq(constraintSnapshots.tripId, run.tripId),
  )).limit(1);
  if (!snapshot) {
    throw Object.assign(new Error("Planning snapshot is unavailable"), { code: "POLICY_DENIED" });
  }
  const candidates = snapshot.destinationCandidates as string[];
  if (candidates.length === 0) {
    throw Object.assign(new Error("Planning snapshot has no destinations"), { code: "PLANNING_DATA_UNAVAILABLE" });
  }
  const departureCities = snapshot.departureCities as string[];
  if (departureCities.length === 0) {
    throw Object.assign(new Error("Planning snapshot has no departure cities"), { code: "PLANNING_DATA_UNAVAILABLE" });
  }
  if (!snapshot.travelDateStart || !snapshot.travelDateEnd) {
    throw Object.assign(new Error("Planning snapshot is missing travel dates"), { code: "PLANNING_DATA_UNAVAILABLE" });
  }

  // Stale-snapshot guard: bind a hash of the v2 projection manifest up front;
  // the finalization transaction re-reads it and rejects writes if it changed.
  const initialManifestHash = hashProjectionManifest(snapshot.authorizedData);

  if (params.signal.aborted) throw params.signal.reason ?? new DOMException("Aborted", "AbortError");

  const resultPlanId = await generatePlan({
    ctx: params.ctx,
    tripId: run.tripId,
    snapshotId: run.snapshotId,
    destination: candidates[0],
    memberIds: [],
    agentTaskRunId: run.id,
    flightSearchPreferencesVersion: run.flightSearchPreferencesVersion,
    staySearchPreferencesVersion: run.staySearchPreferencesVersion ?? undefined,
    signal: params.signal,
    leaseToken: params.leaseToken,
    outputMode: "PROPOSED",
  });

  // Final stale-snapshot guard. Re-reading the projection manifest guarantees
  // a confirmation/revoke that landed between snapshot build and finalization
  // invalidates the proposal (spec §1.7, §5.3). Shared helper from
  // `services/snapshot-manifest-guard.ts` so RESEARCH and PLAN/REPLAN stay in lockstep.
  await assertSnapshotManifestStable(run.snapshotId, initialManifestHash).catch(async (err) => {
    if ((err as { code?: string }).code !== "STALE_SNAPSHOT_GUARD") throw err;
    // Supersede this run as STALE; the latest REPLAN from the mutation wins.
    await db.update(itineraryPlans)
      .set({ status: "STALE", staleReason: "snapshot_manifest_superseded", supersededAt: new Date() })
      .where(and(eq(itineraryPlans.id, resultPlanId), eq(itineraryPlans.status, "PROPOSED")));
    await db.update(tripConstraintFacts)
      .set({})
      .where(eq(tripConstraintFacts.tripId, run.tripId!));
    throw Object.assign(
      new Error("Snapshot projection manifest changed during planning; result plan marked STALE"),
      { code: "STALE_SNAPSHOT_GUARD" },
    );
  });
  logSafeRuntimeEvent(params.ctx, {
    component: "planner", event: "task", operation: run.operation.toLowerCase(), outcome: "success",
    attempt: run.generationAttempt, latencyMs: Date.now() - startedAt,
    relatedRunId: run.id, relatedSnapshotId: run.snapshotId ?? undefined,
  });
  return resultPlanId;
}

// `hashProjectionManifest` and `assertSnapshotManifestStable` now live in
// `services/snapshot-manifest-guard.ts` so the Personal Trip Orchestrator can
// reuse them for the PROPOSE_PLAN path.
