import { and, desc, eq, ne } from "drizzle-orm";

import { db } from "../db/database.js";
import {
  constraintSnapshots,
  sharedTrips,
  tripMembers,
  tripSearchPreferences,
  tripStaySearchPreferences,
  tripPlaces,
} from "../db/schema.js";
import { DefaultPolicyGate } from "../agents/policy-gate.js";
import {
  invokeSkill,
} from "../agents/skill-registry.js";
import {
  type ConstraintSnapshotData,
  type ServiceGap,
} from "../types/domain.js";
import type { AgentTaskRow } from "../tasks/task-repository.js";
import { publishAgentStreamEvent } from "../tasks/task-stream-publisher.js";
import {
  generatePlan,
  researchCoverageForSnapshot,
  type CoverageResearchResult,
} from "../services/planning-service.js";
import { recordPlanningResearchResult } from "../services/planning-research-result-service.js";
import { assertSnapshotManifestStable, hashProjectionManifest } from "../services/snapshot-manifest-guard.js";
import { metrics } from "../observability/metrics.js";
import type { RequestContext } from "../utils/context.js";

export type ResearchRunOutcome = "COMPLETED" | "COMPLETED_WITH_GAPS";

export interface ResearchRunResult {
  outcome: ResearchRunOutcome;
  /** Set when the orchestrator persists a `planning_research_results` row. */
  researchResultId?: string;
  /** Set when the orchestrator synthesizes a `PROPOSED` plan via `generatePlan`. */
  resultPlanId?: string;
}

/**
 * Phase 3 — Personal Trip Orchestrator entry point.
 *
 * Reuses every Shared Skill via `invokeSkill` under `DefaultPolicyGate("shared")`.
 * Inputs to every skill come ONLY from the run row + the immutable snapshot +
 * server-derived search preferences. Chat content is never read here.
 *
 * Branch by `run.researchMode`:
 * - `RESEARCH_ONLY` → persist `planning_research_results`, return `COMPLETED`
 *   (or `COMPLETED_WITH_GAPS` if any capability returned `UNAVAILABLE`).
 * - `PROPOSE_PLAN` → defer to Phase 4 (`generatePlan` synthesis). For now we
 *   still record the research result so the planner can reuse the coverage.
 */
export async function runResearch(params: {
  ctx: RequestContext;
  run: AgentTaskRow;
  signal: AbortSignal;
  /**
   * Phase 4 — testing seam. Production callers omit this and get the default
   * `resolvePlanningDependencies()`. Tests inject `testPlanningDependencies`
   * so the PROPOSE_PLAN branch can exercise the deterministic validator
   * without a real LLM.
   */
  providerOverride?: NonNullable<Parameters<typeof researchCoverageForSnapshot>[0]["providerOverride"]>;
}): Promise<ResearchRunResult> {
  const { run } = params;
  if (!run.tripId || !run.snapshotId) {
    throw new Error("RESEARCH run missing trip/snapshot binding");
  }

  // ─── 1. Snapshot + preferences ────────────────────────────────────────────
  const [snapshot] = await db.select().from(constraintSnapshots)
    .where(eq(constraintSnapshots.id, run.snapshotId))
    .limit(1);
  if (!snapshot) {
    throw Object.assign(new Error("Planning snapshot is unavailable"), { code: "POLICY_DENIED" });
  }
  const destinationCandidates = (snapshot.destinationCandidates as string[]) ?? [];
  const departureCities = (snapshot.departureCities as string[]) ?? [];
  if (destinationCandidates.length === 0 || departureCities.length === 0
    || !snapshot.travelDateStart || !snapshot.travelDateEnd) {
    throw Object.assign(new Error("Planning snapshot is incomplete"), { code: "POLICY_DENIED" });
  }

  const [latestFlightPref] = await db.select().from(tripSearchPreferences)
    .where(eq(tripSearchPreferences.tripId, run.tripId))
    .orderBy(desc(tripSearchPreferences.version))
    .limit(1);
  const [latestStayPref] = await db.select().from(tripStaySearchPreferences)
    .where(eq(tripStaySearchPreferences.tripId, run.tripId))
    .orderBy(desc(tripStaySearchPreferences.version))
    .limit(1);
  const memberRows = await db.select({ userId: tripMembers.userId }).from(tripMembers)
    .where(and(eq(tripMembers.tripId, run.tripId), eq(tripMembers.isRequired, true)));
  const memberIds = memberRows.map((r) => r.userId);
  const requiredCapabilities = (run.requestedCapabilities ?? []) as string[];
  if (requiredCapabilities.length === 0) {
    throw new Error("RESEARCH run has no requestedCapabilities");
  }

  // ─── 2. Build the shared SkillContext ─────────────────────────────────────
  const snapshotData: ConstraintSnapshotData = {
    authorizedData: snapshot.authorizedData as Record<string, unknown>,
    departureCities,
    destinationCandidates,
    travelDateStart: snapshot.travelDateStart,
    travelDateEnd: snapshot.travelDateEnd,
  };
  const baseCtx = {
    ctx: params.ctx,
    snapshot: snapshotData,
    policyGate: new DefaultPolicyGate("shared"),
  };

  // ─── 3. RESEARCHING stage + capability coverage ──────────────────────────
  await publishAgentStreamEvent({
    event: "research.stage",
    runId: run.id,
    generationAttempt: run.generationAttempt,
    stage: "RESEARCHING",
    traceparent: params.ctx.traceparent,
  });

  const gaps: ServiceGap[] = [];

  // 3a. Coverage research (flights + stays) — emits `provider_search_runs`.
  let coverage: CoverageResearchResult | null = null;
  if (requiredCapabilities.includes("flight")) {
    if (!latestFlightPref) {
      gaps.push({ capability: "flight", code: "SEARCH_CONSTRAINTS_INCOMPLETE" });
    } else {
      try {
        coverage = await researchCoverageForSnapshot({
          snapshotId: run.snapshotId,
          agentTaskRunId: run.id,
          departureCities,
          destinationCandidates,
          travelDateStart: snapshot.travelDateStart!,
          travelDateEnd: snapshot.travelDateEnd!,
          signal: params.signal,
          providerOverride: params.providerOverride,
        });
      } catch (err) {
        metrics.inc("research_stage_total", { stage: "RESEARCHING", outcome: "failure" });
        throw err;
      }
      if (coverage.missingDestinations.length > 0) {
        for (const dest of coverage.missingDestinations) {
          gaps.push({ capability: "flight", code: "NO_RESULTS", destinationId: dest });
        }
      }
    }
  }
  metrics.inc("research_stage_total", { stage: "researching", outcome: "success" });

  // ─── 4. Tool loop ─────────────────────────────────────────────────────────
  for (const cap of requiredCapabilities) {
    if (cap === "flight") continue; // already handled via coverage above
    try {
      await invokeCapability(cap, {
        run,
        snapshotData,
        baseCtx,
        latestFlightPref: latestFlightPref ?? null,
        latestStayPref: latestStayPref ?? null,
        memberIds,
        gaps,
        signal: params.signal,
      });
    } catch (err) {
      // Record the failure as a gap and continue with the next capability.
      gaps.push({
        capability: capabilityToService(cap),
        code: classifyError(err),
      });
    }
  }

  // ─── 5. VALIDATING + PERSISTING + persist the safe summary ───────────────
  await publishAgentStreamEvent({
    event: "research.stage",
    runId: run.id,
    generationAttempt: run.generationAttempt,
    stage: "VALIDATING",
    traceparent: params.ctx.traceparent,
  });
  metrics.inc("research_stage_total", { stage: "validating", outcome: "success" });

  await publishAgentStreamEvent({
    event: "research.stage",
    runId: run.id,
    generationAttempt: run.generationAttempt,
    stage: "PERSISTING",
    traceparent: params.ctx.traceparent,
  });

  // ─── 6. PROPOSE_PLAN branch → generatePlan + snapshot-manifest guard ──
  if (run.researchMode === "PROPOSE_PLAN") {
    if (!coverage) {
      // Defensive — coverage is built when "flight" is in requestedCapabilities
      // OR when researchCoverageForSnapshot can still succeed. If neither
      // path ran, refuse to synthesize.
      throw Object.assign(
        new Error("PROPOSE_PLAN requires coverage research to have produced a result"),
        { code: "POLICY_DENIED" },
      );
    }
    if (coverage.missingDestinations.length > 0) {
      // Spec §10.6 — refuse to synthesize a plan when destinations lack stay
      // coverage; the model would be flying blind on those branches.
      throw Object.assign(
        new Error(`Research uncovered all required candidates: ${coverage.missingDestinations.join(", ")}`),
        { code: "PLANNING_DATA_UNAVAILABLE" },
      );
    }

    // Pick a primary destination deterministically (the model still ranks).
    const counts = new Map<string, number>();
    for (const flight of coverage.allFlights) {
      counts.set(flight.destination, (counts.get(flight.destination) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
    const recommended = sorted[0] ?? destinationCandidates[0];

    const initialHash = hashProjectionManifest(snapshot.authorizedData);

    const resultPlanId = await generatePlan({
      ctx: params.ctx,
      tripId: run.tripId,
      snapshotId: run.snapshotId,
      destination: recommended,
      memberIds: [],
      agentTaskRunId: run.id,
      flightSearchPreferencesVersion: run.flightSearchPreferencesVersion ?? undefined,
      staySearchPreferencesVersion: run.staySearchPreferencesVersion ?? undefined,
      signal: params.signal,
      outputMode: "PROPOSED",
      coverage,
    }, params.providerOverride!);

    // Final stale-snapshot guard (spec §1.7, §5.3) — re-reads the
    // projection manifest and rejects writes that landed after our copy.
    try {
      await assertSnapshotManifestStable(run.snapshotId, initialHash);
    } catch (err) {
      metrics.inc("research_stage_total", { stage: "stale", outcome: "failure" });
      await publishAgentStreamEvent({
        event: "research.stage",
        runId: run.id,
        generationAttempt: run.generationAttempt,
        stage: "STALE",
        traceparent: params.ctx.traceparent,
      });
      throw err;
    }

    metrics.inc("research_stage_total", { stage: "completed", outcome: "success" });
    return { outcome: "COMPLETED", resultPlanId };
  }

  // ─── 7. RESEARCH_ONLY branch → persist safe summary + record gaps ───────
  const status: "COMPLETE" | "COMPLETED_WITH_GAPS" = gaps.length === 0 ? "COMPLETE" : "COMPLETED_WITH_GAPS";
  const researchResultId = await recordPlanningResearchResult({
    ctx: params.ctx,
    tripId: run.tripId,
    snapshotId: run.snapshotId,
    agentTaskRunId: run.id,
    status,
    serviceGaps: gaps.slice(0, 32),
  });

  const outcome: ResearchRunOutcome = status === "COMPLETE" ? "COMPLETED" : "COMPLETED_WITH_GAPS";
  return { outcome, researchResultId };
}

interface InvokeCapabilityArgs {
  run: AgentTaskRow;
  snapshotData: ConstraintSnapshotData;
  baseCtx: {
    ctx: RequestContext;
    snapshot: ConstraintSnapshotData;
    policyGate: DefaultPolicyGate;
  };
  latestFlightPref: typeof tripSearchPreferences.$inferSelect | null;
  latestStayPref: typeof tripStaySearchPreferences.$inferSelect | null;
  memberIds: string[];
  gaps: ServiceGap[];
  signal: AbortSignal;
}

async function invokeCapability(cap: string, args: InvokeCapabilityArgs): Promise<void> {
  const { run, snapshotData, baseCtx, latestFlightPref, latestStayPref, memberIds, gaps, signal } = args;
  const snapshotId = run.snapshotId!;
  const tripId = run.tripId!;
  const destinationCandidates = snapshotData.destinationCandidates;
  const traceparent = run.traceContext?.traceparent;

  switch (cap) {
    case "accommodation": {
      for (const dest of destinationCandidates) {
        const result = await invokeSkill(
          "accommodation.discover",
          {
            ...baseCtx,
            accommodationDiscovery: { tripId, snapshotId, agentTaskRunId: run.id },
          },
          { snapshotId, destinationId: dest },
          { expectedVersion: "1.0.0", signal },
        ) as { outcome: "LIVE" | "UNAVAILABLE"; code?: ServiceGap["code"] };
        if (result.outcome === "UNAVAILABLE" && result.code) {
          gaps.push({ capability: "accommodation", code: result.code, destinationId: dest });
        }
      }
      return;
    }

    case "hotel": {
      // Phase 5 — Hotel capability is feature-flagged. When
      // PLAN_ENABLE_HOTEL !== "true", record a soft gap and skip so the
      // run completes without invoking a search the deployment isn't ready
      // for. Mirrors the planning-task-handler guard (`PLAN_ENABLE_HOTEL`
      // + `staySearchPreferencesVersion`).
      if (process.env.PLAN_ENABLE_HOTEL !== "true") {
        gaps.push({ capability: "hotel", code: "PROVIDER_NOT_APPROVED" });
        return;
      }
      if (!latestStayPref) {
        gaps.push({ capability: "hotel", code: "SEARCH_CONSTRAINTS_INCOMPLETE" });
        return;
      }
      // Locale is derived from the Trip's title locale (en | zh). Phase 5
      // mirrors the existing title generation flow; Phase 6 may hoist this
      // to a per-user preference.
      const tripLocale = (await db
        .select({ titleLocale: sharedTrips.titleLocale })
        .from(sharedTrips)
        .where(eq(sharedTrips.id, run.tripId!))
        .limit(1))[0]?.titleLocale ?? "en";
      const locale = tripLocale === "zh" ? "zh" : "en";
      for (const dest of destinationCandidates) {
        const result = await invokeSkill(
          "hotel.search",
          {
            ...baseCtx,
            hotelSearch: {
              tripId,
              snapshotId,
              searchPreferencesVersion: latestStayPref.version,
              searchPreferences: {
                roomCount: latestStayPref.roomCount,
                adultsPerRoom: latestStayPref.adultsPerRoom,
                currency: latestStayPref.currency,
              },
              locale,
              agentTaskRunId: run.id,
            },
          },
          { snapshotId, destinationId: dest },
          { expectedVersion: "1.0.0", signal },
        ) as { outcome: "LIVE" | "UNAVAILABLE"; code?: ServiceGap["code"] };
        if (result.outcome === "UNAVAILABLE" && result.code) {
          gaps.push({ capability: "hotel", code: result.code, destinationId: dest });
        }
      }
      return;
    }

    case "activities": {
      if (!latestFlightPref) {
        gaps.push({ capability: "activities", code: "SEARCH_CONSTRAINTS_INCOMPLETE" });
        return;
      }
      for (const dest of destinationCandidates) {
        const result = await invokeSkill(
          "activities.search",
          {
            ...baseCtx,
            activitiesSearch: {
              tripId,
              snapshotId,
              currency: latestFlightPref.currency,
              agentTaskRunId: run.id,
            },
          },
          { snapshotId, destinationId: dest, locale: "en" },
          { expectedVersion: "1.0.0", signal },
        ) as { outcome: "LIVE" | "UNAVAILABLE"; code?: ServiceGap["code"] };
        if (result.outcome === "UNAVAILABLE" && result.code) {
          gaps.push({ capability: "activities", code: result.code, destinationId: dest });
        }
      }
      return;
    }

    case "places": {
      // places.search only — places.adopt requires an LLM-decided candidate
      // envelope and is intentionally deferred to the UI adoption flow.
      for (const dest of destinationCandidates) {
        const result = await invokeSkill(
          "places.search",
          {
            ...baseCtx,
            placeSearch: { tripId, snapshotId, agentTaskRunId: run.id },
          },
          { snapshotId, destinationId: dest, keyword: "attraction", category: "ATTRACTION" },
          { expectedVersion: "1.0.0", signal },
        ) as { outcome: "LIVE" | "UNAVAILABLE"; code?: ServiceGap["code"] };
        if (result.outcome === "UNAVAILABLE" && result.code) {
          gaps.push({ capability: "places", code: result.code, destinationId: dest });
        }
      }
      return;
    }

    case "navigation": {
      const places = await loadRoutablePlaces(tripId);
      if (places.length < 2) {
        gaps.push({ capability: "navigation", code: "SEARCH_CONSTRAINTS_INCOMPLETE" });
        return;
      }
      const result = await invokeSkill(
        "navigation.route",
        { ...baseCtx, navigation: { tripId, snapshotId, agentTaskRunId: run.id } },
        { snapshotId, originPlaceId: places[0]!.id, destinationPlaceId: places[1]!.id, mode: "WALK" },
        { expectedVersion: "1.0.0", signal },
      ) as { outcome: "LIVE" | "UNAVAILABLE"; code?: ServiceGap["code"] };
      if (result.outcome === "UNAVAILABLE" && result.code) {
        gaps.push({ capability: "navigation", code: result.code });
      }
      return;
    }

    case "mobility": {
      const places = await loadRoutablePlaces(tripId);
      if (places.length < 2 || !latestFlightPref) {
        gaps.push({ capability: "mobility", code: "SEARCH_CONSTRAINTS_INCOMPLETE" });
        return;
      }
      const result = await invokeSkill(
        "mobility.search",
        { ...baseCtx, mobility: { tripId, snapshotId, agentTaskRunId: run.id } },
        {
          snapshotId,
          originPlaceId: places[0]!.id,
          destinationPlaceId: places[1]!.id,
          passengers: latestFlightPref.adults,
          departureAt: new Date(`${snapshotData.travelDateStart}T09:00:00.000Z`).toISOString(),
          serviceType: "TAXI",
        },
        { expectedVersion: "1.0.0", signal },
      ) as { outcome: "LIVE" | "UNAVAILABLE"; code?: ServiceGap["code"] };
      if (result.outcome === "UNAVAILABLE" && result.code) {
        gaps.push({ capability: "mobility", code: result.code });
      }
      return;
    }

    case "readiness": {
      for (const dest of destinationCandidates) {
        if (memberIds.length === 0) {
          gaps.push({ capability: "readiness", code: "SEARCH_CONSTRAINTS_INCOMPLETE", destinationId: dest });
          continue;
        }
        // readiness.check is a stub today (no provider integration). Any
        // resolved value counts as success — gaps only on a thrown error.
        await invokeSkill(
          "readiness.check",
          baseCtx,
          { destination: dest, memberIds },
          { expectedVersion: "1.0.0", signal },
        );
      }
      return;
    }

    default:
      // Unknown capability — ignore for forward compatibility.
      return;
  }

  void traceparent; // Reserved for future SSE enrichment.
}

async function loadRoutablePlaces(tripId: string): Promise<Array<{ id: string }>> {
  return db.select({ id: tripPlaces.id }).from(tripPlaces).where(and(
    eq(tripPlaces.tripId, tripId),
    eq(tripPlaces.status, "ACTIVE"),
    ne(tripPlaces.visibility, "OWNER_PRIVATE"),
  )).orderBy(tripPlaces.createdAt).limit(2);
}

/**
 * Map a request-level capability to the `service_gaps.capability` enum
 * (`flight | stay | hotel | accommodation | activities | places | navigation |
 * transit | mobility | readiness`).
 */
function capabilityToService(cap: string): ServiceGap["capability"] {
  switch (cap) {
    case "flight": return "flight";
    case "hotel": return "hotel";
    case "accommodation": return "accommodation";
    case "activities": return "activities";
    case "places": return "places";
    case "navigation": return "navigation";
    case "mobility": return "mobility";
    case "readiness": return "readiness";
    default: return "activities";
  }
}

function classifyError(err: unknown): ServiceGap["code"] {
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (message.includes("timeout")) return "UPSTREAM_TIMEOUT";
  if (message.includes("rate")) return "RATE_LIMITED";
  if (message.includes("upstream")) return "UPSTREAM_FAILURE";
  if (message.includes("not_configured") || message.includes("not configured")) return "NOT_CONFIGURED";
  if (message.includes("policy")) return "SEARCH_CONSTRAINTS_INCOMPLETE";
  return "UPSTREAM_FAILURE";
}
