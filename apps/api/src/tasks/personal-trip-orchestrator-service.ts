import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";

import { db } from "../db/database.js";
import {
  constraintSnapshots,
  sharedTrips,
  tripMembers,
  tripSearchPreferences,
  tripStaySearchPreferences,
  tripPlaces,
  researchRouteSelections,
} from "../db/schema.js";
import { DefaultPolicyGate } from "../agents/policy-gate.js";
import {
  invokeSkill,
} from "../agents/skill-registry.js";
import {
  type ConstraintSnapshotData,
  type ServiceGap,
  type ServiceGapCode,
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
import { PlanAdoptionServiceError, soloAdoptProposedPlan } from "../services/plan-adoption-service.js";
import { recordAudit } from "../services/audit-service.js";
import { metrics } from "../observability/metrics.js";
import { logSafeRuntimeEvent } from "../observability/telemetry.js";
import { SkillError } from "../agents/errors.js";
import { resolveBoundHotelProvider } from "../providers/live-provider-factory.js";
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
          tripId: run.tripId,
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
          gaps.push({ capability: "stay", code: "NO_RESULTS", destinationId: dest });
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
      const code = classifyError(err);
      gaps.push({ capability: capabilityToService(cap), code });
      // Without this the swallow was total: a capability could fail on every
      // run and leave nothing behind but a gap code the traveller reads as a
      // supplier outage. The payload is the bounded classification only —
      // never the exception message, which can carry provider or user text.
      logSafeRuntimeEvent(params.ctx, {
        component: "planner",
        event: "capability",
        operation: cap,
        outcome: "failure",
        errorCode: code,
        relatedRunId: run.id,
        relatedSnapshotId: run.snapshotId ?? undefined,
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
    // Research completeness and commercial authority are separate gates.
    // An unavailable cell is a visible gap, not a failed run.
    //
    // A destination qualifies on *any* live evidence, not specifically on
    // flights. `evaluatedDestinations` is exactly that set: coverage research
    // adds a destination when a flight search came back LIVE and when
    // accommodation coverage was confirmed. Requiring flights on top of stay
    // coverage meant one refused flight request — a supplier 4xx, our own bad
    // parameters, a city with no controlled airport — withheld everything else
    // the run had verified. What each capability did or did not return is
    // stated as a gap on the plan itself instead.
    //
    // Zero live evidence still yields no plan: a card naming a destination and
    // nothing else is not a plan, and `AGENTS.md` forbids presenting it as one.
    const uncoveredStays = new Set(coverage.missingDestinations);
    const evaluated = new Set(coverage.evaluatedDestinations);
    const eligibleDestinations = destinationCandidates.filter((destination) => evaluated.has(destination));
    if (eligibleDestinations.length === 0) {
      for (const destination of destinationCandidates) {
        if (!coverage.allFlights.some((flight) => flight.destination === destination)) {
          gaps.push({ capability: "flight", code: "NO_RESULTS", destinationId: destination });
        }
      }
      const researchResultId = await recordPlanningResearchResult({
        ctx: params.ctx,
        tripId: run.tripId,
        snapshotId: run.snapshotId,
        agentTaskRunId: run.id,
        status: "COMPLETED_WITH_GAPS",
        serviceGaps: dedupeGaps(gaps).slice(0, 32),
      });
      metrics.inc("research_stage_total", { stage: "completed", outcome: "success" });
      return { outcome: "COMPLETED_WITH_GAPS", researchResultId };
    }

    // Pick a primary eligible destination deterministically (the model still
    // ranks within the evidence it is allowed to cite). Flight count remains
    // the ranking signal where flights exist — more routes is a better answer
    // for a traveller — and snapshot candidate order breaks the tie when none
    // of the eligible destinations has any, so a flightless run still picks
    // the same destination on every replay.
    const counts = new Map<string, number>();
    for (const flight of coverage.allFlights) {
      if (!eligibleDestinations.includes(flight.destination)) continue;
      counts.set(flight.destination, (counts.get(flight.destination) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
    const recommended = sorted[0] ?? eligibleDestinations[0];

    // Whatever the recommended destination did not get, say so on the plan.
    // These two used to be refusals — missing stay coverage threw
    // `PLANNING_DATA_UNAVAILABLE`, and a destination without flights never
    // became eligible at all. Both are now gaps the proposal card renders as
    // explicit UNAVAILABLE rows, which is the same treatment every other
    // capability already got.
    if (uncoveredStays.has(recommended)) {
      gaps.push({ capability: "stay", code: "NO_RESULTS", destinationId: recommended });
    }
    if (!coverage.allFlights.some((flight) => flight.destination === recommended)) {
      gaps.push({ capability: "flight", code: "NO_RESULTS", destinationId: recommended });
    }

    const initialHash = hashProjectionManifest(snapshot.authorizedData);

    // P3 (planner-resilience §6.4): outer wall-clock cap on the synthesis
    // call. Merged with the caller-provided signal so lease-loss /
    // cancellation still short-circuits. Default 180s reads
    // `PLANNING_RUN_DEADLINE_MS`. Note: this only applies to the
    // PROPOSE_PLAN synthesis call; coverage research above is bounded by
    // the Worker lease / queue TTL.
    const planningRunDeadlineMs = Number(process.env.PLANNING_RUN_DEADLINE_MS ?? 180_000);
    const runDeadlineController = new AbortController();
    const planningRunSignal = AbortSignal.any([params.signal, runDeadlineController.signal]);
    const runDeadlineTimer = setTimeout(() => {
      runDeadlineController.abort(new Error("Planning run deadline exceeded"));
    }, planningRunDeadlineMs);

    let synthesis;
    try {
      synthesis = await generatePlan({
        ctx: params.ctx,
        tripId: run.tripId,
        snapshotId: run.snapshotId,
        destination: recommended,
        memberIds: [],
        agentTaskRunId: run.id,
        flightSearchPreferencesVersion: run.flightSearchPreferencesVersion ?? undefined,
        staySearchPreferencesVersion: run.staySearchPreferencesVersion ?? undefined,
        signal: planningRunSignal,
        outputMode: "PROPOSED",
        coverage,
      }, params.providerOverride!);
    } finally {
      clearTimeout(runDeadlineTimer);
    }

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

    // Per §1.3 of the planner-resilience design, the synthesis outcome is a
    // discriminator: a destination with no commercial flight authority
    // produces a research summary rather than a plan. We forward the summary
    // to the caller without triggering solo auto-accept (no plan to adopt).
    if (synthesis.outcome === "RESEARCH_SUMMARY") {
      metrics.inc("research_stage_total", { stage: "completed", outcome: "research_summary" });
      return { outcome: "COMPLETED_WITH_GAPS", researchResultId: synthesis.researchResultId };
    }

    const resultPlanId = synthesis.planId;

    // ─── 6.5 Solo auto-accept (Quick orchestration) ────────────────────────
    // The owner has already explicitly confirmed the research request via
    // the conversational setup card; on Solo trips we close the loop by
    // flipping the freshly-generated PROPOSED plan to ACTIVE inline. Failure
    // paths are swallowed (PLAN_NOT_PROPOSED, PLAN_ADOPTED, NOT_SOLO) — the
    // research has succeeded and the user should see a usable terminal
    // state; only catastrophic errors rethrow. The plan stays `PROPOSED`
    // when swallow fires so the existing team-vote / manual adopt path
    // still works.
    if (run.createdByUserId) {
      try {
        await soloAdoptProposedPlan({
          ctx: params.ctx,
          planId: resultPlanId,
          userId: run.createdByUserId,
        });
        metrics.inc("research_auto_accept_total", { outcome: "adopted" });
        await recordAudit({
          ctx: params.ctx,
          action: "PLAN_ADOPTION_VOTED",
          actorUserId: run.createdByUserId,
          tripId: run.tripId!,
          summary: { decision: "ACCEPT", path: "solo_auto", planStatusAtVote: "PROPOSED" },
        });
      } catch (err) {
        if (err instanceof PlanAdoptionServiceError) {
          switch (err.code) {
            case "PLAN_NOT_PROPOSED":
              metrics.inc("research_auto_accept_total", { outcome: "stale_plan" });
              break;
            case "PLAN_ADOPTED":
              metrics.inc("research_auto_accept_total", { outcome: "already_adopted" });
              break;
            case "NOT_SOLO":
              metrics.inc("research_auto_accept_total", { outcome: "not_solo" });
              break;
            default:
              // Unknown error code: log and continue (do not fail the
              // research run — the user already paid the LLM cost).
              metrics.inc("research_auto_accept_total", { outcome: "error" });
          }
        } else {
          // Unexpected (non-ServiceError) — log and continue.
          metrics.inc("research_auto_accept_total", { outcome: "error" });
        }
      }
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

function dedupeGaps(gaps: ReadonlyArray<ServiceGap>): ServiceGap[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => {
    const key = `${gap.capability}:${gap.code}:${gap.destinationId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      const hotelProviderResolution = await resolveBoundHotelProvider(run.id);
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
              provider: hotelProviderResolution.providerName,
              providerAdapter: hotelProviderResolution.adapter,
              ...(hotelProviderResolution.authorization ? { quoteNationalityAuthorization: hotelProviderResolution.authorization } : {}),
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
      const selection = await loadRouteSelection(run);
      if (!selection) {
        gaps.push({ capability: "navigation", code: "SEARCH_CONSTRAINTS_INCOMPLETE" });
        return;
      }
      const result = await invokeSkill(
        "navigation.route",
        { ...baseCtx, navigation: { tripId, snapshotId, agentTaskRunId: run.id } },
        { snapshotId, originPlaceId: selection.originPlaceId, destinationPlaceId: selection.destinationPlaceId, mode: selection.mode },
        { expectedVersion: "1.0.0", signal },
      ) as { outcome: "LIVE" | "UNAVAILABLE"; code?: ServiceGap["code"] };
      if (result.outcome === "UNAVAILABLE" && result.code) {
        gaps.push({ capability: "navigation", code: result.code });
      }
      return;
    }

    case "mobility": {
      const selection = await loadRouteSelection(run);
      if (!selection || !latestFlightPref) {
        gaps.push({ capability: "mobility", code: "SEARCH_CONSTRAINTS_INCOMPLETE" });
        return;
      }
      const result = await invokeSkill(
        "mobility.search",
        { ...baseCtx, mobility: { tripId, snapshotId, agentTaskRunId: run.id } },
        {
          snapshotId,
          originPlaceId: selection.originPlaceId,
          destinationPlaceId: selection.destinationPlaceId,
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

async function loadRouteSelection(run: AgentTaskRow): Promise<{ originPlaceId: string; destinationPlaceId: string; mode: "WALK" | "DRIVE" | "CYCLE" } | null> {
  if (!run.tripId || !run.originatingIntentRunId) return null;
  const [selection] = await db.select().from(researchRouteSelections).where(and(
    eq(researchRouteSelections.intentRunId, run.originatingIntentRunId),
    eq(researchRouteSelections.tripId, run.tripId),
    eq(researchRouteSelections.ownerUserId, run.createdByUserId),
  )).limit(1);
  if (!selection) return null;
  const places = await db.select({ id: tripPlaces.id }).from(tripPlaces).where(and(
    eq(tripPlaces.tripId, run.tripId),
    eq(tripPlaces.status, "ACTIVE"),
    ne(tripPlaces.visibility, "OWNER_PRIVATE"),
    inArray(tripPlaces.id, [selection.originPlaceId, selection.destinationPlaceId]),
  ));
  if (places.length !== 2) return null;
  return { originPlaceId: selection.originPlaceId, destinationPlaceId: selection.destinationPlaceId, mode: selection.mode };
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

/**
 * Turn a failed capability invocation into the gap code the traveller will
 * eventually read.
 *
 * `SkillError` carries a typed code, so classify on that first and treat the
 * message only as a last resort for foreign errors. Reading the text was how
 * this produced its worst answers: nothing in "Output validation failed for
 * accommodation.discover" matches any of the substrings below, so a Skill
 * rejecting its own valid output fell through to the default and told the
 * traveller a healthy supplier was down. It is the same failure as
 * `docs/shared-agent-findings.md` #21, where a quota message containing
 * "limit: 25000" was read as a 5xx by a regex over the message.
 *
 * The default stays `UPSTREAM_FAILURE` — an unclassifiable foreign error is
 * more likely an upstream one — but every code we can actually name now gets
 * named before we reach it.
 */
export function classifyError(err: unknown): ServiceGapCode {
  if (err instanceof SkillError) {
    switch (err.code) {
      case "TIMEOUT":
        return "UPSTREAM_TIMEOUT";
      case "RATE_LIMITED":
        return "RATE_LIMITED";
      case "NETWORK":
      case "UPSTREAM_5XX":
      case "UPSTREAM_FAILURE":
        return "UPSTREAM_FAILURE";
      // Our contract, not the supplier's health. The provider may well have
      // answered correctly and had its answer refused on the way out.
      case "INPUT_INVALID":
      case "OUTPUT_INVALID":
      case "SCHEMA_PARSE":
      case "SKILL_VERSION_MISMATCH":
      case "PLAN_VALIDATION_FAILED":
      case "UNKNOWN_SKILL":
        return "SKILL_CONTRACT_VIOLATION";
      // The call was refused before it left: authority, scope, or a missing
      // snapshot. Repaired by completing the request, not by retrying.
      case "POLICY_DENIED":
      case "TOOL_NOT_ALLOWED":
      case "SNAPSHOT_REQUIRED":
      case "SEARCH_PREFERENCES_STALE":
        return "SEARCH_CONSTRAINTS_INCOMPLETE";
    }
  }
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (message.includes("timeout")) return "UPSTREAM_TIMEOUT";
  if (message.includes("rate")) return "RATE_LIMITED";
  if (message.includes("upstream")) return "UPSTREAM_FAILURE";
  if (message.includes("not_configured") || message.includes("not configured")) return "NOT_CONFIGURED";
  if (message.includes("policy")) return "SEARCH_CONSTRAINTS_INCOMPLETE";
  return "UPSTREAM_FAILURE";
}

/**
 * Idempotent server-managed pin write — called on terminal research.stage
 * events (COMPLETED / COMPLETED_WITH_GAPS) so the trip header always
 * points at the latest owner-accepted terminal run. Never throws —
 * a pin failure must not block the orchestrator's terminal completion
 * event, which has already fired by the time this runs.
 *
 * Inverse of `pinSessionIfAbsent` (confirm path): one writes the run
 * the moment it is accepted; this one re-points to the run once it
 * actually finishes. Idempotent under both predicates:
 *   `pinned_session_id IS NULL OR pinned_session_id <> $runId`.
 */
export async function pinSessionIfTerminal(params: {
  ctx: RequestContext;
  tripId: string;
  runId: string;
  outcome: "COMPLETED" | "COMPLETED_WITH_GAPS";
  actorUserId?: string;
}): Promise<{ written: boolean }> {
  try {
    const result = await db.update(sharedTrips)
      .set({
        pinnedSessionId: params.runId,
        pinnedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(sharedTrips.id, params.tripId),
        or(
          isNull(sharedTrips.pinnedSessionId),
          ne(sharedTrips.pinnedSessionId, params.runId),
        ),
      ))
      .returning({ pinnedSessionId: sharedTrips.pinnedSessionId });

    const written = result.length > 0;
    if (written) {
      await recordAudit({
        ctx: params.ctx,
        action: "TRIP_PIN_SESSION_WRITTEN",
        ...(params.actorUserId ? { actorUserId: params.actorUserId } : {}),
        tripId: params.tripId,
        summary: { runId: params.runId, path: "orchestrator", outcome: params.outcome },
      });
      metrics.inc("pin_write_total", { path: "orchestrator", outcome: "success" });
    } else {
      metrics.inc("pin_write_total", { path: "orchestrator", outcome: "skipped" });
    }
    return { written };
  } catch {
    metrics.inc("pin_write_total", { path: "orchestrator", outcome: "failure" });
    return { written: false };
  }
}
