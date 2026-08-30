import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import { db } from "../../db/database.js";
import {
  constraintSnapshots,
  itineraryPlans,
  tripConstraintFacts,
  tripMembers,
} from "../../db/schema.js";
import {
  generatePlan,
  researchCoverageForSnapshot,
  extractSnapshotV2Meta,
} from "../../services/planning-service.js";
import type { RequestContext } from "../../utils/context.js";
import { logSafeRuntimeEvent } from "../../observability/telemetry.js";
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
  const startedAt = Date.now();
  logSafeRuntimeEvent(params.ctx, {
    component: "planner", event: "task", operation: run.operation.toLowerCase(), outcome: "started",
    attempt: run.generationAttempt,
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

  // Phase 3 / spec §6.1 — iterate the full candidate matrix.
  const coverage = await researchCoverageForSnapshot({
    snapshotId: run.snapshotId,
    agentTaskRunId: run.id,
    departureCities,
    destinationCandidates: candidates,
    travelDateStart: snapshot.travelDateStart,
    travelDateEnd: snapshot.travelDateEnd,
    signal: params.signal,
  });
  logSafeRuntimeEvent(params.ctx, {
    component: "planner", event: "research_coverage", operation: run.operation.toLowerCase(), outcome: "success",
    attempt: run.generationAttempt, latencyMs: Date.now() - startedAt,
    itemCount: coverage.allFlights.length,
  });

  // If any candidate lacks stay coverage, refuse to synthesize a plan: the
// model would be flying blind on those branches (spec §10.6). POI / route
// evidence is gathered through the LLM tool loop when the corresponding
// capability is enabled.
  if (coverage.missingDestinations.length > 0) {
    throw Object.assign(
      new Error(`Research uncovered all required candidates: ${coverage.missingDestinations.join(", ")}`),
      { code: "PLANNING_DATA_UNAVAILABLE" },
    );
  }
  if (params.signal.aborted) throw params.signal.reason ?? new DOMException("Aborted", "AbortError");

  // Pick a destination recommendation from coverage. The model still ranks;
  // here we choose the destination with the most flights as a deterministic
  // primary. Selection is advisory; the user votes the proposal regardless.
  const counts = new Map<string, number>();
  for (const flight of coverage.allFlights) {
    counts.set(flight.destination, (counts.get(flight.destination) ?? 0) + 1);
  }
  const sortedDestinations = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
  const recommended = sortedDestinations[0] ?? candidates[0];

  const resultPlanId = await generatePlan({
    ctx: params.ctx,
    tripId: run.tripId,
    snapshotId: run.snapshotId,
    destination: recommended,
    memberIds: [],
    agentTaskRunId: run.id,
    flightSearchPreferencesVersion: run.flightSearchPreferencesVersion,
    staySearchPreferencesVersion: run.staySearchPreferencesVersion ?? undefined,
    signal: params.signal,
    leaseToken: params.leaseToken,
    outputMode: "PROPOSED",
    coverage,
  });

  // Final stale-snapshot guard. Re-reading the projection manifest guarantees
  // a confirmation/revoke that landed between snapshot build and finalization
  // invalidates the proposal (spec §1.7, §5.3).
  const [finalSnapshot] = await db.select().from(constraintSnapshots).where(eq(constraintSnapshots.id, run.snapshotId)).limit(1);
  if (finalSnapshot && hashProjectionManifest(finalSnapshot.authorizedData) !== initialManifestHash) {
    // Supersede this run as STALE; the latest REPLAN from the mutation wins.
    await db.update(itineraryPlans)
      .set({ status: "STALE", staleReason: "snapshot_manifest_superseded", supersededAt: new Date() })
      .where(and(eq(itineraryPlans.id, resultPlanId), eq(itineraryPlans.status, "PROPOSED")));
    await db.update(tripConstraintFacts)
      .set({})
      .where(eq(tripConstraintFacts.tripId, run.tripId));
    throw Object.assign(
      new Error("Snapshot projection manifest changed during planning; result plan marked STALE"),
      { code: "STALE_SNAPSHOT_GUARD" },
    );
  }
  logSafeRuntimeEvent(params.ctx, {
    component: "planner", event: "task", operation: run.operation.toLowerCase(), outcome: "success",
    attempt: run.generationAttempt, latencyMs: Date.now() - startedAt,
  });
  return resultPlanId;
}

/**
 * Stable manifest hash — set of `(sourceId|revision|visibility)` tuples sorted
 * lexicographically. A change in this hash means a fact mutation occurred while
 * the worker was running its long-tail (spec §1.7).
 */
export function hashProjectionManifest(authorizedData: unknown): string {
  const meta = extractSnapshotV2Meta(authorizedData);
  const tuples: string[] = [];
  for (const entry of meta?.projectionManifest ?? []) {
    tuples.push(`${entry.sourceId}|${entry.revision}|${entry.visibility}`);
  }
  tuples.sort();
  return createHash("sha256").update(tuples.join("\n")).digest("hex");
}
