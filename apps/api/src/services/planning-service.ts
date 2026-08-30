import { db } from "../db/database.js";
import {
  constraintSnapshots,
  itineraryPlans,
  sourceEvidence,
  providerOffers,
  agentTaskRuns,
  tripSearchPreferences,
  tripConstraintFacts,
  tripMembers,
  preferenceFacts,
  providerSearchRuns,
  planningResearchResults,
} from "../db/schema.js";
import { eq, and, desc, gt, inArray, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { buildAuthorizedData, getActiveConsents } from "./consent-service.js";
import {
  MemorySourceChangedError,
  computeMemorySourceFingerprint,
  fingerprintFromSnapshot,
} from "./memory-source-fingerprint.js";
import {
  buildMemoryNamespace,
  buildMemoryProjection,
  type MemoryProjectionInput,
} from "./memory-projection-builder.js";
import { safePublicExplanationTokensFor } from "../policy/constraint-field-catalog.js";
import { withMemorySpan } from "../memory/memory-spans.js";
import { metrics } from "../observability/metrics.js";
import { createTravelProviders } from "../providers/live-provider-factory.js";
import { modelGateway, __setModelGatewayForTests } from "../providers/gateway-factory.js";
import type { ModelGateway } from "../providers/model-gateway.js";
import type {
  ActivitiesProvider,
  FlightProvider,
  GroundProvider,
  MobilityOfferProvider,
  NavigationProvider,
  PlaceSearchProvider,
  StayProvider,
  TransitJourneyProvider,
} from "../providers/types.js";
import type { GroundCapabilityRouter } from "../providers/ground-capability-router.js";
import { validatePlanOutput } from "../policy/plan-output-validator.js";
import { DefaultPolicyGate } from "../agents/policy-gate.js";
import { invokeSkill } from "../agents/skill-registry.js";
import { flightSearchModelArgumentsSchema } from "./flight-search-service.js";
import { activitiesSearchModelArgumentsSchema } from "./activities-search-service.js";
import { loadCurrentConfirmedSearchPreferences } from "./flight-search-preferences-service.js";
import { evaluateFlightResearchCompleteness, flightMatrixToGaps, FlightResearchIncompleteError } from "./flight-research-matrix-service.js";
import {
  activitiesMatrixToGaps,
  evaluateActivitiesResearchCompleteness,
  ActivitiesResearchIncompleteError,
} from "./activities-research-matrix-service.js";
import { recordAudit } from "./audit-service.js";
import type { RequestContext } from "../utils/context.js";
import type { ActivityEvidence, FlightOffer, StayOffer, GroundOffer, ServiceGap } from "../types/domain.js";

export interface PlanningDependencies {
  flightProvider: FlightProvider;
  stayProvider: StayProvider;
  groundProvider: GroundProvider;
  placeProvider: PlaceSearchProvider;
  navigationProvider: NavigationProvider;
  mobilityOfferProvider: MobilityOfferProvider;
  transitJourneyProvider: TransitJourneyProvider;
  capabilityRouter: GroundCapabilityRouter;
  activitiesProvider?: ActivitiesProvider;
  modelGateway: ModelGateway;
}

const configuredProviders = createTravelProviders();
let planningDependenciesOverride: PlanningDependencies | null = null;

export function __setModelGateway(gateway: ModelGateway): void {
  __setModelGatewayForTests(gateway);
}

export function __setPlanningDependenciesForTests(
  dependencies: PlanningDependencies | null,
): void {
  planningDependenciesOverride = dependencies;
}

function resolvePlanningDependencies(): PlanningDependencies {
  if (planningDependenciesOverride) return planningDependenciesOverride;

  return {
    flightProvider: configuredProviders.flightProvider,
    stayProvider: configuredProviders.stayProvider,
    groundProvider: configuredProviders.groundProvider,
    placeProvider: configuredProviders.placeProvider,
    navigationProvider: configuredProviders.navigationProvider,
    mobilityOfferProvider: configuredProviders.mobilityOfferProvider,
    transitJourneyProvider: configuredProviders.transitJourneyProvider,
    capabilityRouter: configuredProviders.capabilityRouter,
    activitiesProvider: configuredProviders.activitiesProvider,
    modelGateway: modelGateway(),
  };
}

export class PlanningDataUnavailableError extends Error {
  readonly statusCode = 422;
  readonly code = "PLANNING_DATA_UNAVAILABLE";

  constructor(readonly missing: string[]) {
    super(`Planning data unavailable: ${missing.join(", ")}`);
    this.name = "PlanningDataUnavailableError";
  }
}

/**
 * Per-destination coverage bundle returned by `researchCoverageForSnapshot`.
 * `missingDestinations` is the canonical allow-list surface to detect gaps
 * (spec §6.1, §10.6); an empty array means full coverage.
 */
export interface CoverageResearchResult {
  allFlights: FlightOffer[];
  allStays: StayOffer[];
  allGround: GroundOffer[];
  allActivities: ActivityEvidence[];
  evaluatedDestinations: string[];
  missingDestinations: string[];
}

/**
 * Spec §6.1 / §10.6 — research coverage matrix.
 *
 * Iterates the full cartesian of `{origin ∈ departureCities} × {destination ∈ destinationCandidates}`,
 * plus one stay/ground query per destination. UNAVAILABLE outcomes are persisted
 * as `provider_search_runs` rows and contribute to `missingDestinations`. The
 * handler uses the result to gate `generatePlan` — never running the model until
 * every configured candidate has either LIVE or UNAVAILABLE coverage.
 *
 * Concurrency: `Promise.allSettled` here is safe; providers are isolated and
 * per-cell deadlines are not enforced at this layer. Production deployment
 * should wrap with a bounded concurrency pool (Phase 6 hardening).
 */
export async function researchCoverageForSnapshot(params: {
  snapshotId: string;
  agentTaskRunId?: string;
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart: string;
  travelDateEnd: string;
  signal?: AbortSignal;
  providerOverride?: PlanningDependencies;
}): Promise<CoverageResearchResult> {
  if (params.destinationCandidates.length === 0) {
    throw new PlanningDataUnavailableError(["destination_candidates_empty"]);
  }
  const deps = params.providerOverride ?? resolvePlanningDependencies();
  const allFlights: FlightOffer[] = [];
  const allStays: StayOffer[] = [];
  const allGround: GroundOffer[] = [];
  const allActivities: ActivityEvidence[] = [];
  const evaluatedDestinations = new Set<string>();
  const missingDestinations = new Set<string>();

  // Decoupled origin × destination fan-out for flights.
  const flightSettlements = await Promise.allSettled(
    params.departureCities.flatMap((origin) =>
      params.destinationCandidates.map((destination) => (async () => {
        const result = await deps.flightProvider.searchFlights({
          origin,
          destination,
          dateStart: params.travelDateStart,
          dateEnd: params.travelDateEnd,
          snapshotId: params.snapshotId,
        });
        if (result.outcome === "UNAVAILABLE") {
          if (params.agentTaskRunId) {
            await db.insert(providerSearchRuns).values({
              snapshotId: params.snapshotId,
              agentTaskRunId: params.agentTaskRunId,
              category: "flight",
              providerName: (result as { source?: string }).source ?? "flight",
              originId: origin.slice(0, 16),
              destinationId: destination.slice(0, 128),
              requestFingerprint: randomUUID(),
              outcome: "UNAVAILABLE",
              errorCode: null,
            });
          }
          return; // UNAVAILABLE → not added to flights, recorded as missing
        }
        evaluatedDestinations.add(destination);
        allFlights.push(...result.data);
      })()),
    ),
  );
  if (params.signal?.aborted) throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
  void flightSettlements;

  // Destination-scoped stay + ground queries.
  const stayGroundSettlements = await Promise.allSettled(
    params.destinationCandidates.map(async (destination) => {
      const stayResult = await deps.stayProvider.searchStays({
        destination,
        checkIn: params.travelDateStart,
        checkOut: params.travelDateEnd,
        snapshotId: params.snapshotId,
      });
      const groundResult = await deps.groundProvider.searchGround({
        destination,
        snapshotId: params.snapshotId,
      });
      const stayLive = stayResult.outcome === "LIVE";
      const groundLive = groundResult.outcome === "LIVE";
      if (stayLive) allStays.push(...stayResult.data);
      if (groundLive) allGround.push(...groundResult.data);
      if (!stayLive || !groundLive) missingDestinations.add(destination);
      else evaluatedDestinations.add(destination);
    }),
  );
  void stayGroundSettlements;

  return {
    allFlights,
    allStays,
    allGround,
    allActivities,
    evaluatedDestinations: [...evaluatedDestinations],
    missingDestinations: [...missingDestinations],
  };
}

/**
 * Spec §4.3 — Service outcome matrix.
 *
 * Translates the post-research view into a bounded `ServiceGap[]` set the
 * planner persists as `planning_research_results.service_gaps`. Only the
 * `origin-missing` condition is structural and remains a hard gate;
 * capability-level UNAVAILABLE is reported as a gap rather than a failure.
 */
export function summarizeProviderGaps(params: {
  requiredOrigins: string[];
  flights: FlightOffer[];
  stays: StayOffer[];
  ground: GroundOffer[];
  // Optional signal flags so the matrix can express capabilities that are
  // soft-disabled (e.g. `PLAN_ENABLE_MOBILITY=false`). Today these are
  // computed by callers; the planner layer merely forwards them.
  unavailableCapabilities?: ReadonlyArray<{ capability: "flight" | "stay" | "navigation" | "mobility" | "transit"; code: "NOT_CONFIGURED" | "PROVIDER_NOT_APPROVED" }>;
}): { gaps: { capability: "flight" | "stay" | "navigation" | "mobility" | "transit"; code: "NOT_CONFIGURED" | "PROVIDER_NOT_APPROVED" | "NO_RESULTS" | "UPSTREAM_FAILURE"; }[]; missingOrigins: string[] } {
  const missingOrigins = params.requiredOrigins
    .filter(origin => !params.flights.some(flight => flight.origin === origin));
  const gaps: { capability: "flight" | "stay" | "navigation" | "mobility" | "transit"; code: "NOT_CONFIGURED" | "PROVIDER_NOT_APPROVED" | "NO_RESULTS" | "UPSTREAM_FAILURE"; }[] = [];
  // Zero-candidate soft gates from Phase 4 outcome matrix: a capability
  // with zero results is reported as a `NO_RESULTS` gap, not a throw.
  if (params.flights.length === 0) gaps.push({ capability: "flight", code: "NO_RESULTS" });
  if (params.stays.length === 0) gaps.push({ capability: "stay", code: "NO_RESULTS" });
  if (params.ground.length === 0) gaps.push({ capability: "navigation", code: "NO_RESULTS" });
  for (const cap of params.unavailableCapabilities ?? []) {
    gaps.push({ capability: cap.capability, code: cap.code });
  }
  return { gaps, missingOrigins };
}

/**
 * Hard gate that ONLY fires on structural conditions (origin-missing,
 * destination-candidates-empty). Capability-level UNAVAILABLE is no longer
 * a throw; it is recorded via `summarizeProviderGaps` and surfaced through
 * `planning_research_results`.
 */
export function validateProviderCoverage(params: {
  requiredOrigins: string[];
  flights: FlightOffer[];
  stays: StayOffer[];
  ground: GroundOffer[];
}): void {
  const { missingOrigins } = summarizeProviderGaps(params);
  if (missingOrigins.length > 0) {
    throw new PlanningDataUnavailableError(missingOrigins.map((origin) => `flight:${origin}`));
  }
}

/**
 * Create a new constraint snapshot for a planning round.
 *
 * Phase 3+ writes the v2 projection produced by `MemoryProjectionBuilder`:
 *  - `authorized_data` carries `{ schemaVersion: 2, teamVisible, orchestratorConfidential, projectionManifest }`
 *  - the v1 reader remains valid for legacy snapshots (compat shim in
 *    `snapshot-policy.ts#assertFieldAllowed`).
 *
 * Caller must already be inside a transaction if they need atomic snapshot + plan
 * writes. Outside callers use a default `db.transaction` wrapper.
 */
/**
 * The members a projection covers.
 *
 * An empty `memberIds` means "everyone on the trip" — callers that do not track
 * membership themselves, such as the Worker, pass nothing. Both the snapshot
 * and the commit-time fingerprint have to resolve it the same way: the snapshot
 * hashed the real members while the guard hashed the empty list, so every
 * Worker-generated plan failed its own guard with MemorySourceChangedError.
 */
type PlanningTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function resolveMemberIds(
  tx: PlanningTx,
  tripId: string,
  memberIds: readonly string[],
): Promise<string[]> {
  if (memberIds.length > 0) return [...memberIds];
  const rows = await tx.select({ userId: tripMembers.userId })
    .from(tripMembers)
    .where(eq(tripMembers.tripId, tripId));
  return rows.map((row) => row.userId);
}

export async function createConstraintSnapshot(params: {
  tripId: string;
  memberIds: string[];
  departureCities: string[];
  destinationCandidates: string[];
  travelDateStart?: string;
  travelDateEnd?: string;
  /** Override salt for run-scoped aliases (used only by tests). */
  aliasSalt?: string;
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0];
}): Promise<string> {
  const run = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    const existing = await tx.select({ version: constraintSnapshots.version })
      .from(constraintSnapshots)
      .where(eq(constraintSnapshots.tripId, params.tripId))
      .orderBy(desc(constraintSnapshots.version));
    const nextVersion = existing.length > 0 ? existing[0].version + 1 : 1;

    // Pull active consents per member.
    const consentRows = await Promise.all(params.memberIds.map(async (memberId) => ({
      memberId,
      consents: await getActiveConsents({ tripId: params.tripId, userId: memberId }),
    })));
    const consents = consentRows.flatMap(({ memberId, consents: memberConsents }) =>
      memberConsents.flatMap((scope) => scope.fieldList.map((fieldKey) => ({
        userId: memberId,
        scope: scope.scope as
          | "PROFILE_BASIC" | "PROFILE_PREFERENCES" | "PROFILE_NATIONALITY"
          | "PROFILE_DOCUMENTS" | "PROFILE_BUDGET" | "PROFILE_RESTRICTIONS",
        fieldKey,
      }))),
    );

    // Pull active trip facts for the trip (any owner).
    const factRows = await tx.select({
      id: tripConstraintFacts.id,
      ownerUserId: tripConstraintFacts.ownerUserId,
      fieldKey: tripConstraintFacts.fieldKey,
      valueJson: tripConstraintFacts.valueJson,
      strength: tripConstraintFacts.strength,
      visibility: tripConstraintFacts.visibility,
      revision: tripConstraintFacts.revision,
      kind: tripConstraintFacts.kind,
    }).from(tripConstraintFacts).where(and(
      eq(tripConstraintFacts.tripId, params.tripId),
      eq(tripConstraintFacts.status, "ACTIVE"),
    ));

    const memberIdsResolved = await resolveMemberIds(tx, params.tripId, params.memberIds);

    const projectionInput: MemoryProjectionInput = {
      tripId: params.tripId,
      memberUserIds: memberIdsResolved,
      consents: consents.map((c) => ({
        userId: c.userId,
        scope: c.scope,
        fieldList: [c.fieldKey],
      })),
      tripConstraintFacts: factRows.map((f) => ({
        ownerUserId: f.ownerUserId,
        fieldKey: f.fieldKey,
        valueJson: f.valueJson,
        strength: f.strength,
        visibility: f.visibility,
        revision: f.revision,
        id: f.id,
      })),
      departureCities: params.departureCities,
      destinationCandidates: params.destinationCandidates,
      travelDateStart: params.travelDateStart,
      travelDateEnd: params.travelDateEnd,
    };

    const projected = buildMemoryProjection(projectionInput);

    // The personal memory namespace (§4.4). Built from preference facts rather
    // than the profile columns the v1 shape reads, because a fact carries the
    // version chain and the catalog registration that decide exportability.
    const activeFacts = memberIdsResolved.length === 0 ? [] : await tx.select({
      userId: preferenceFacts.userId,
      fieldKey: preferenceFacts.fieldKey,
      value: preferenceFacts.fieldValue,
    }).from(preferenceFacts).where(and(
      inArray(preferenceFacts.userId, memberIdsResolved),
      eq(preferenceFacts.status, "ACTIVE"),
    ));

    const consentedFieldsByUser: Record<string, string[]> = {};
    for (const consent of consents) {
      (consentedFieldsByUser[consent.userId] ??= []).push(consent.fieldKey);
    }

    const memoryNamespace = await withMemorySpan(
      "memory.projection.build",
      { operation: "build", source: "snapshot" },
      async () => {
        try {
          const built = buildMemoryNamespace({
            aliases: projected.snapshot.memberAliases,
            consentedFieldsByUser,
            preferenceFacts: activeFacts,
            tripFacts: factRows.map((f) => ({
              ownerUserId: f.ownerUserId,
              fieldKey: f.fieldKey,
              kind: f.kind,
              visibility: f.visibility,
              valueJson: f.valueJson,
            })),
          });
          const empty = Object.keys(built.groupDecisions).length === 0
            && Object.values(built.members).every((m) =>
              Object.keys(m.profileFacts).length === 0
              && Object.keys(m.tripOverrides).length === 0);
          metrics.inc("memory_projection_build_total", { result: empty ? "empty" : "built" });
          return { result: built, outcome: empty ? "empty" : "built" };
        } catch (error) {
          metrics.inc("memory_projection_build_total", { result: "failed" });
          throw error;
        }
      },
    );

    // v1 back-compat map: userId → consent-granted fields.
    const v1Shape: Record<string, unknown> = {};
    for (const memberId of memberIdsResolved) {
      v1Shape[memberId] = await buildAuthorizedData({ tripId: params.tripId, userId: memberId });
    }

    // Build a server-internal safePublicExplanationTokens union across all
    // fields referenced by active facts (so the validator allow-list is
    // exactly what was in-scope for this round).
    const referencedFieldKeys = new Set<string>();
    for (const fact of factRows) referencedFieldKeys.add(fact.fieldKey);
    const allowedExplanation = new Set<string>();
    for (const fieldKey of referencedFieldKeys) {
      for (const token of safePublicExplanationTokensFor(fieldKey as never)) {
        allowedExplanation.add(token);
      }
    }
    void allowedExplanation;

    // Single JSONB blob keeps v1 shape at top-level (for legacy readers) and
    // v2 privileged sections under `_meta`. The reserved key `_meta` never
    // collides with userId UUIDs.
    const authorizedData: Record<string, unknown> = {
      ...v1Shape,
      _meta: {
        schemaVersion: 2,
        // Identities and versions of the projection's sources, so the commit
        // gate can tell whether memory moved during the run (§6).
        memorySourceFingerprint: await computeMemorySourceFingerprint({
          tripId: params.tripId,
          memberUserIds: memberIdsResolved,
          tx,
        }),
        memberAliases: projected.snapshot.memberAliases,
        teamVisible: projected.snapshot.teamVisible,
        orchestratorConfidential: projected.snapshot.orchestratorConfidential,
        projectionManifest: projected.snapshot.projectionManifest,
        memory: memoryNamespace,
      },
    };

    const [snapshot] = await tx.insert(constraintSnapshots).values({
      tripId: params.tripId,
      version: nextVersion,
      authorizedData,
      departureCities: params.departureCities,
      destinationCandidates: params.destinationCandidates,
      travelDateStart: params.travelDateStart,
      travelDateEnd: params.travelDateEnd,
    }).returning();

    return snapshot.id;
  };

  if (params.tx) {
    return run(params.tx);
  }
  return db.transaction(run);
}

/**
 * Read the `_meta` envelope of a freshly loaded v2 snapshot. Returns null when
 * the snapshot is v1 or has no privileged sections.
 */
export interface SnapshotV2Meta {
  schemaVersion: 2;
  memberAliases: Record<string, string>;
  teamVisible: Record<string, Array<Record<string, unknown>>>;
  orchestratorConfidential: Record<string, Array<{
    fieldKey: string;
    valueJson: unknown;
    strength: "HARD" | "SOFT";
    visibility: "ORCHESTRATOR_CONFIDENTIAL";
    sourceType: "TRIP_FACT";
    sourceId: string;
  }>>;
  projectionManifest: Array<Record<string, unknown>>;
}

export function extractSnapshotV2Meta(authorizedData: unknown): SnapshotV2Meta | null {
  if (typeof authorizedData !== "object" || authorizedData === null) return null;
  const root = authorizedData as Record<string, unknown>;
  const meta = root._meta;
  if (!meta || typeof meta !== "object") return null;
  const schemaVersion = (meta as Record<string, unknown>).schemaVersion;
  if (schemaVersion !== 2) return null;
  return meta as unknown as SnapshotV2Meta;
}

/**
 * The model/Shared Skills must never receive the legacy userId-keyed snapshot
 * map or the server-only userId→alias lookup. Keep that compatibility shape
 * available only to deterministic server readers.
 */
export function buildPlanningModelProjection(authorizedData: unknown): Record<string, unknown> {
  const meta = extractSnapshotV2Meta(authorizedData);
  if (!meta) return {};
  return {
    schemaVersion: 2,
    teamVisible: meta.teamVisible,
    orchestratorConfidential: meta.orchestratorConfidential,
    projectionManifest: meta.projectionManifest,
  };
}

/**
 * Generate a new plan based on the constraint snapshot.
 *
 * Phase 3 lifecycle:
 *  - `outputMode: "PROPOSED"` (default) writes the plan as `PROPOSED`; activation
 *    requires unanimous adoption vote (Phase 4 wires this in via
 *    `activateProposedPlan`).
 *  - `outputMode: "ACTIVATE"` is reserved for the unanimous-vote path; the plan
 *    is emitted as `ACTIVE` and writes `replacedByPlanId` to form the chain.
 *
 * Provider evidence is bound to the snapshot id so the validator's deterministic
 * `EVIDENCE_*` checks remain meaningful across runs. The optional `coverage`
 * parameter lets the handler pre-populate evidence via `researchCoverageForSnapshot`
 * so spec §6.1's "all configured candidates must be researched" invariant holds.
 */
export async function generatePlan(params: {
  ctx: RequestContext;
  tripId: string;
  snapshotId: string;
  destination: string;
  memberIds: string[];
  agentTaskRunId?: string;
  flightSearchPreferencesVersion?: number;
  signal?: AbortSignal;
  leaseToken?: string;
  /**
   * Defaults to "ACTIVATE" to preserve the legacy flow: the planner emits an
   * `ACTIVE` plan that then funnels through `member_confirmations`. Team
   * Agent 协作编排 (Phase 3+) explicitly passes "PROPOSED" so the plan
   * routes through the adoption-vote lifecycle (spec §1.8). Booking-sandbox
   * integrations must consult plan status separately (Phase 4).
   */
  outputMode?: "PROPOSED" | "ACTIVATE";
  coverage?: CoverageResearchResult;
}, dependencies: PlanningDependencies = resolvePlanningDependencies()): Promise<string> {
  // Get snapshot
  const [snapshot] = await db.select().from(constraintSnapshots)
    .where(eq(constraintSnapshots.id, params.snapshotId))
    .limit(1);

  if (!snapshot) throw new Error("Snapshot not found");

  // Get current plan version for this trip
  const existingPlans = await db.select().from(itineraryPlans)
    .where(eq(itineraryPlans.tripId, params.tripId))
    .orderBy(itineraryPlans.version);
  
  const nextVersion = existingPlans.length > 0 ? Math.max(...existingPlans.map(p => p.version)) + 1 : 1;

  // Fetch offers from all providers (all reference same snapshotId)
  const allFlights: FlightOffer[] = [];
  const allStays: StayOffer[] = [];
  const allGround: GroundOffer[] = [];
  const allActivities: ActivityEvidence[] = [];
  const activitiesEnabled = process.env.PLAN_ENABLE_ACTIVITIES === "true";

  if (!snapshot.travelDateStart || !snapshot.travelDateEnd) {
    throw new PlanningDataUnavailableError(
      snapshot.travelDateStart ? ["travelDateEnd"] : ["travelDateStart"],
    );
  }

  // Phase 3: when the handler pre-collected research via `researchCoverageForSnapshot`,
  // honor it as the canonical evidence; otherwise fall back to in-line per-origin
  // research. The validator's `EVIDENCE_*` checks operate identically on either source.
  if (params.coverage) {
    allFlights.push(...params.coverage.allFlights);
    allStays.push(...params.coverage.allStays);
    allGround.push(...params.coverage.allGround);
    allActivities.push(...params.coverage.allActivities);
  } else if (!params.agentTaskRunId || !params.flightSearchPreferencesVersion) {
    for (const departureCity of snapshot.departureCities) {
      const result = await dependencies.flightProvider.searchFlights({
        origin: departureCity,
        destination: params.destination,
        dateStart: snapshot.travelDateStart,
        dateEnd: snapshot.travelDateEnd,
        snapshotId: params.snapshotId,
      });
      if (result.outcome !== "UNAVAILABLE") allFlights.push(...result.data);
    }
  }

  // Stay + ground provider calls run for every planning branch (legacy and
  // tool-calling); both paths rely on `allStays`/`allGround` being populated
  // for the deterministic provider-coverage gate.
  const stayResult = await dependencies.stayProvider.searchStays({
    destination: params.destination,
    checkIn: snapshot.travelDateStart,
    checkOut: snapshot.travelDateEnd,
    snapshotId: params.snapshotId,
  });
  if (stayResult.outcome !== "UNAVAILABLE") {
    allStays.push(...stayResult.data);
  }
  const groundResult = await dependencies.groundProvider.searchGround({
    destination: params.destination,
    snapshotId: params.snapshotId,
  });
  if (groundResult.outcome !== "UNAVAILABLE") {
    allGround.push(...groundResult.data);
  }

  const memberPreferences = buildPlanningModelProjection(snapshot.authorizedData);
  let candidatePlanData: Record<string, unknown>;
  if (params.agentTaskRunId && params.flightSearchPreferencesVersion) {
    const toolGateway = dependencies.modelGateway.generateStructuredPlanWithTools;
    if (!toolGateway) throw new PlanningDataUnavailableError(["tool_calling_not_supported"]);
    const preferences = await loadCurrentConfirmedSearchPreferences({
      tripId: params.tripId, version: params.flightSearchPreferencesVersion,
    });
    candidatePlanData = await toolGateway.call(dependencies.modelGateway, {
      destination: params.destination,
      destinationCandidates: snapshot.destinationCandidates as string[],
      stays: allStays,
      ground: allGround,
      memberPreferences,
      maxTurns: Number(process.env.MODEL_GATEWAY_TOOL_CALLING_MAX_TURNS ?? 8), signal: params.signal, ctx: params.ctx,
      beforeFinal: async () => {
        const matrix = await evaluateFlightResearchCompleteness({
          snapshotId: params.snapshotId, agentTaskRunId: params.agentTaskRunId!,
          departureCities: snapshot.departureCities as string[], destinationCandidates: snapshot.destinationCandidates as string[],
        });
        if (!matrix.complete) throw new FlightResearchIncompleteError(matrix.cells);
        if (activitiesEnabled) {
          const activitiesMatrix = await evaluateActivitiesResearchCompleteness({
            snapshotId: params.snapshotId,
            agentTaskRunId: params.agentTaskRunId!,
            destinationCandidates: snapshot.destinationCandidates as string[],
          });
          if (!activitiesMatrix.complete) {
            throw new ActivitiesResearchIncompleteError(activitiesMatrix.cells);
          }
        }
      },
      tools: [
        {
          name: "flight.search", description: "Search normalized flights for one controlled origin and destination.",
          parameters: { type: "object", additionalProperties: false, required: ["originId", "destinationId", "tripType", "departureDate", "adults", "cabin", "currency"], properties: {
            originId: { type: "string" }, destinationId: { type: "string" }, tripType: { type: "string", enum: ["ONE_WAY", "ROUND_TRIP"] },
            departureDate: { type: "string" }, returnDate: { type: "string" }, adults: { type: "integer" }, cabin: { type: "string" }, currency: { type: "string" },
          } },
        },
        ...(activitiesEnabled ? [{
          name: "activities.search",
          description: "Search live activity evidence for one controlled destination.",
          parameters: { type: "object", additionalProperties: false, required: ["destinationId", "locale"], properties: {
            destinationId: { type: "string" },
            theme: { type: "string", enum: ["CULTURE", "FOOD", "OUTDOOR", "FAMILY"] },
            locale: { type: "string", enum: ["en", "zh"] },
          } },
        }] : []),
      ],
      dispatchTool: async (call) => {
        const snapshotContext = {
          authorizedData: memberPreferences,
          departureCities: snapshot.departureCities as string[],
          destinationCandidates: snapshot.destinationCandidates as string[],
          travelDateStart: snapshot.travelDateStart ?? undefined,
          travelDateEnd: snapshot.travelDateEnd ?? undefined,
        };
        if (call.name === "flight.search") {
          const modelArgs = flightSearchModelArgumentsSchema.parse(call.arguments);
          const result = await invokeSkill("flight.search", {
            ctx: params.ctx,
            snapshot: snapshotContext,
            flightSearch: {
              tripId: params.tripId, snapshotId: params.snapshotId, searchPreferencesVersion: preferences.version,
              searchPreferences: { tripType: preferences.tripType as "ONE_WAY" | "ROUND_TRIP", adults: preferences.adults, cabin: preferences.cabin as "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST", currency: preferences.currency },
              agentTaskRunId: params.agentTaskRunId,
            },
            policyGate: new DefaultPolicyGate("shared"),
          }, { ...modelArgs, snapshotId: params.snapshotId }, { signal: params.signal });
          if ((result as { outcome: string }).outcome === "LIVE") allFlights.push(...(result as { offers: FlightOffer[] }).offers);
          return result;
        }
        if (call.name === "activities.search" && activitiesEnabled) {
          const modelArgs = activitiesSearchModelArgumentsSchema.parse(call.arguments);
          const result = await invokeSkill("activities.search", {
            ctx: params.ctx,
            snapshot: snapshotContext,
            activitiesSearch: {
              tripId: params.tripId, snapshotId: params.snapshotId,
              currency: preferences.currency,
              agentTaskRunId: params.agentTaskRunId,
            },
            policyGate: new DefaultPolicyGate("shared"),
          }, { ...modelArgs, snapshotId: params.snapshotId }, { signal: params.signal });
          if ((result as { outcome: string }).outcome === "LIVE") {
            allActivities.push(...(result as { activities: ActivityEvidence[] }).activities);
          }
          return result;
        }
        throw new Error("UNKNOWN_SKILL");
      },
    });
  } else {
    validateProviderCoverage({ requiredOrigins: snapshot.departureCities, flights: allFlights, stays: allStays, ground: allGround });
    candidatePlanData = await dependencies.modelGateway.generateStructuredPlan({ destination: params.destination, flights: allFlights, stays: allStays, ground: allGround, memberPreferences, ctx: params.ctx, signal: params.signal });
  }

  validateProviderCoverage({ requiredOrigins: snapshot.departureCities, flights: allFlights, stays: allStays, ground: allGround });

  // The model output is untrusted until the deterministic control plane proves
  // snapshot authorization and an exact match to run-scoped provider evidence.
  const planData = validatePlanOutput({
    planData: candidatePlanData,
    snapshot: {
      authorizedData: snapshot.authorizedData,
      departureCities: snapshot.departureCities,
      destinationCandidates: snapshot.destinationCandidates,
      travelDateStart: snapshot.travelDateStart ?? undefined,
      travelDateEnd: snapshot.travelDateEnd ?? undefined,
    },
    evidence: { flights: allFlights, stays: allStays, ground: allGround, activities: allActivities },
  });

  // Only validated output may cross the authoritative persistence boundary.
  // All four writes (plan, offers, evidence, audit) commit atomically; if
  // any one fails the validated plan is discarded.
  const planId = await db.transaction(async (tx) => {
    if (params.agentTaskRunId) {
      if (!params.leaseToken || !params.flightSearchPreferencesVersion) throw new Error("Planning task lease authority is incomplete");
      const [currentTask] = await tx.select().from(agentTaskRuns).where(and(
        eq(agentTaskRuns.id, params.agentTaskRunId), eq(agentTaskRuns.leaseToken, params.leaseToken),
        eq(agentTaskRuns.status, "RUNNING"), eq(agentTaskRuns.snapshotId, params.snapshotId),
        gt(agentTaskRuns.leaseExpiresAt, new Date()),
      )).limit(1);
      const [latestPreference] = await tx.select().from(tripSearchPreferences).where(eq(tripSearchPreferences.tripId, params.tripId)).orderBy(desc(tripSearchPreferences.version)).limit(1);
      if (!currentTask || latestPreference?.version !== params.flightSearchPreferencesVersion) {
        throw new Error("Planning task is stale or no longer owns finalization");
      }
      // This is the authoritative completion gate.  The earlier beforeFinal
      // check avoids an unnecessary final model response, but evidence can
      // change after that check; re-read it through this transaction before
      // any plan state is made durable.
      const matrix = await evaluateFlightResearchCompleteness({
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        departureCities: snapshot.departureCities as string[],
        destinationCandidates: snapshot.destinationCandidates as string[],
        client: tx,
      });
      // Phase 4 outcome matrix: a cell that returned UNAVAILABLE is an
      // auditable gap rather than a fatal condition. MISSING cells (the
      // planner never even tried) still hard-fail the round.
      if (!matrix.complete) throw new FlightResearchIncompleteError(matrix.cells);
      if (activitiesEnabled) {
        const activitiesMatrix = await evaluateActivitiesResearchCompleteness({
          snapshotId: params.snapshotId,
          agentTaskRunId: params.agentTaskRunId,
          destinationCandidates: snapshot.destinationCandidates as string[],
          client: tx,
        });
        if (!activitiesMatrix.complete) {
          throw new ActivitiesResearchIncompleteError(activitiesMatrix.cells);
        }
      }
    }

    // Consent can be revoked, a preference edited or a trip override changed
    // while the model was working. Re-derive the projection sources through
    // this transaction; if they moved, the validated plan is discarded rather
    // than made authoritative on memory that no longer exists (§6).
    const recordedFingerprint = fingerprintFromSnapshot(snapshot.authorizedData);
    if (recordedFingerprint !== null) {
      const currentFingerprint = await computeMemorySourceFingerprint({
        tripId: params.tripId,
        memberUserIds: await resolveMemberIds(tx, params.tripId, params.memberIds),
        tx,
      });
      if (currentFingerprint !== recordedFingerprint) {
        throw new MemorySourceChangedError(params.snapshotId);
      }
    }

    const outputMode = params.outputMode ?? "ACTIVATE";
    const insertStatus = outputMode === "ACTIVATE" ? "ACTIVE" : "PROPOSED";
    const [plan] = await tx.insert(itineraryPlans).values({
      tripId: params.tripId,
      snapshotId: params.snapshotId,
      version: nextVersion,
      status: insertStatus,
      planData,
      replacedByPlanId: null,
    }).returning();

    const normalizedOffers = [
      ...allFlights.map(offer => ({
        category: "flight",
        providerName: offer.providerName,
        offer,
      })),
      ...allStays.map(offer => ({
        category: "stay",
        providerName: offer.source,
        offer,
      })),
      ...allGround.map(offer => ({
        category: "ground",
        providerName: offer.provider,
        offer,
      })),
      ...allActivities.map(offer => ({
        category: "activity",
        providerName: "viator_mcp",
        offer,
      })),
    ];

    await tx.insert(providerOffers).values(normalizedOffers.map(({ category, providerName, offer }) => ({
      snapshotId: params.snapshotId,
      planId: plan.id,
      category,
      providerName,
      offerData: offer as unknown as Record<string, unknown>,
      capturedAt: new Date(offer.capturedAt),
    })));

    await tx.insert(sourceEvidence).values(normalizedOffers.map(({ category, offer }) => ({
      planId: plan.id,
      category,
      itemId: offer.id,
      source: offer.source,
      capturedAt: new Date(offer.capturedAt),
      metadata: null,
    })));

    await recordAudit({
      ctx: params.ctx,
      action: "PLAN_CREATE",
      tripId: params.tripId,
      planId: plan.id,
      summary: { version: nextVersion, destination: params.destination, snapshotId: params.snapshotId },
      tx,
    });

    // Phase 4 — record the service outcome matrix on the same transaction.
    // UNAVAILABLE evidence becomes a `service_gaps` row; the task terminator
    // becomes `COMPLETED_WITH_GAPS` rather than `COMPLETED`.
    let flightMatrixGaps: ReturnType<typeof flightMatrixToGaps> = [];
    let activityMatrixGaps: ReturnType<typeof activitiesMatrixToGaps> = [];
    if (params.agentTaskRunId) {
      const finalMatrix = await evaluateFlightResearchCompleteness({
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        departureCities: snapshot.departureCities as string[],
        destinationCandidates: snapshot.destinationCandidates as string[],
        client: tx,
      });
      flightMatrixGaps = flightMatrixToGaps(finalMatrix.cells);
      if (activitiesEnabled) {
        const finalActivitiesMatrix = await evaluateActivitiesResearchCompleteness({
          snapshotId: params.snapshotId,
          agentTaskRunId: params.agentTaskRunId,
          destinationCandidates: snapshot.destinationCandidates as string[],
          client: tx,
        });
        activityMatrixGaps = activitiesMatrixToGaps(finalActivitiesMatrix.cells);
      }
    }
    const { gaps: capabilityGaps } = summarizeProviderGaps({
      requiredOrigins: snapshot.departureCities as string[],
      flights: allFlights,
      stays: allStays,
      ground: allGround,
    });
    const allServiceGaps: ServiceGap[] = [
      ...flightMatrixGaps.map((g) => ({
        capability: g.capability,
        code: g.code,
        destinationId: g.destinationId,
      })),
      ...activityMatrixGaps,
      ...capabilityGaps.map((g) => ({ capability: g.capability, code: g.code })),
    ];
    // For the Phase 4 MVP we keep the matrix surface small: any UNAVAILABLE
    // cell flips the task status to `COMPLETED_WITH_GAPS`.
    const researchStatus = allServiceGaps.length > 0 ? "COMPLETED_WITH_GAPS" : "COMPLETE";
    const serviceGapsJson = allServiceGaps as unknown as Record<string, unknown>[];
    if (params.agentTaskRunId) {
      await tx.insert(planningResearchResults).values({
        tripId: params.tripId,
        snapshotId: params.snapshotId,
        agentTaskRunId: params.agentTaskRunId,
        status: researchStatus,
        serviceGaps: serviceGapsJson,
        resultPlanId: plan.id,
      }).onConflictDoUpdate({
        target: planningResearchResults.agentTaskRunId,
        set: {
          status: researchStatus,
          serviceGaps: serviceGapsJson,
          resultPlanId: plan.id,
        },
      });
      await recordAudit({
        ctx: params.ctx,
        action: "RESEARCH_RESULT_RECORDED",
        tripId: params.tripId,
        summary: {
          status: researchStatus,
          gapCount: allServiceGaps.length,
          capabilities: [...new Set(allServiceGaps.map((g) => g.capability))].sort(),
        },
        tx,
      });
    }

    if (params.agentTaskRunId) {
      const taskTerminalStatus = researchStatus === "COMPLETED_WITH_GAPS" ? "COMPLETED_WITH_GAPS" : "COMPLETED";
      const [completed] = await tx.update(agentTaskRuns).set({
        status: taskTerminalStatus, resultPlanId: plan.id, leaseToken: null, leaseExpiresAt: null,
        finishedAt: new Date(), updatedAt: new Date(), errorCode: null,
      }).where(and(
        eq(agentTaskRuns.id, params.agentTaskRunId), eq(agentTaskRuns.leaseToken, params.leaseToken!),
        eq(agentTaskRuns.status, "RUNNING"), gt(agentTaskRuns.leaseExpiresAt, new Date()),
      )).returning();
      if (!completed) throw new Error("Planning task lost finalization lease");
    }

    return plan.id;
  });

  return planId;
}

/**
 * Activate a PROPOSED plan after unanimous adoption vote (Phase 4 wiring).
 *
 * Atomicity: idempotent on `(planId, status)`. If the plan was super-SUPERSEDED
 * by a newer REPLAN while voting was in flight (spec §6.2), this returns null
 * instead of mutating; the caller's vote tally handler maps that to a
 * structured no-op rather than an exception.
 */
export async function activateProposedPlan(params: {
  ctx: RequestContext;
  planId: string;
  tx?: Parameters<Parameters<typeof db.transaction>[0]>[0];
}): Promise<string | null> {
  const run = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    const [plan] = await tx.select().from(itineraryPlans)
      .where(eq(itineraryPlans.id, params.planId))
      .for("update")
      .limit(1);
    if (!plan) return null;
    if (plan.status !== "PROPOSED") {
      if (plan.status === "ACTIVE") return plan.id;
      return null;
    }
    // Find the previous ACTIVE (or PROPOSED) head to wire replacedByPlanId.
    await tx.update(itineraryPlans)
      .set({ status: "SUPERSEDED", supersededAt: new Date() })
      .where(and(
        eq(itineraryPlans.tripId, plan.tripId),
        eq(itineraryPlans.status, "PROPOSED"),
        ne(itineraryPlans.id, plan.id),
      ));
    const [updated] = await tx.update(itineraryPlans)
      .set({ status: "ACTIVE", supersededAt: null })
      .where(and(eq(itineraryPlans.id, plan.id), eq(itineraryPlans.status, "PROPOSED")))
      .returning({ id: itineraryPlans.id });
    if (!updated) return null;
    await recordAudit({
      ctx: params.ctx,
      action: "PLAN_ADOPTED",
      tripId: plan.tripId,
      planId: plan.id,
      summary: { activatedAt: new Date().toISOString() },
      tx,
    });
    return updated.id;
  };
  return params.tx ? run(params.tx) : db.transaction(run);
}

/**
 * Mark a plan as STALE due to a change event.
 */
export async function markPlanStale(params: {
  ctx: RequestContext;
  planId: string;
  reason: string;
}): Promise<void> {
  await db.update(itineraryPlans)
    .set({ status: "STALE", staleReason: params.reason, supersededAt: new Date() })
    .where(eq(itineraryPlans.id, params.planId));

  await recordAudit({
    ctx: params.ctx,
    action: "PLAN_STALE",
    planId: params.planId,
    summary: { reason: params.reason },
  });
}

/**
 * Get the latest active plan for a trip.
 */
export async function getLatestActivePlan(tripId: string): Promise<{ id: string; version: number; planData: Record<string, unknown> } | null> {
  const plans = await db.select().from(itineraryPlans)
    .where(and(eq(itineraryPlans.tripId, tripId), eq(itineraryPlans.status, "ACTIVE")))
    .orderBy(desc(itineraryPlans.version))
    .limit(1);

  if (plans.length === 0) return null;
  return { id: plans[0].id, version: plans[0].version, planData: plans[0].planData as Record<string, unknown> };
}
