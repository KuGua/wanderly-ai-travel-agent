/**
 * DRAFT Personal Research service — capability-specific executor dispatcher.
 *
 * The Personal Research handler (`personal-research-task-handler.ts`) calls
 * a single `executePersonalResearch()` here, which dispatches by the run's
 * `requestedCapabilities[0]` value to the corresponding capability
 * executor under `personal-research-executors/`.
 *
 * Each executor mirrors the shape of the Shared `executeAndPersist*`
 * functions but writes its bounded summary directly to
 * `personal_research_evidence` (never to `provider_offers` /
 * `provider_search_runs` / `itinerary_plans` etc.). Failures and provider
 * unavailability map to `outcome: "UNAVAILABLE"` with a typed errorCode —
 * no fixture / model content / Demo data fallback (spec §6).
 *
 * Source: docs/draft-personal-research-implementation.md §3.2.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/database.js";
import {
  agentTaskRuns,
  personalResearchEvidence,
} from "../db/schema.js";
import { isPersonalResearchCapabilityAllowed, type PersonalResearchOperationCapability } from "../config/personal-research-allowed-capabilities.js";
import type { PersonalResearchEvidenceSummary, PersonalResearchOwnerDraft } from "../types/domain.js";
import type { AgentTaskRow } from "../tasks/task-repository.js";
import { executePersonalFlightSearch } from "./personal-research-executors/flight.js";
import { executePersonalHotelSearch } from "./personal-research-executors/hotel.js";

const PROVIDER_NAME_BY_CAPABILITY: Record<PersonalResearchOperationCapability, string> = {
  "flight.search": "personal-flight-adapter",
  "hotel.search": "personal-hotel-adapter",
  "accommodation.discovery": "personal-accommodation-adapter",
  "activities.search": "personal-activities-adapter",
  "places.search": "personal-places-adapter",
  "navigation.route": "personal-navigation-adapter",
  "mobility.search": "personal-mobility-adapter",
};

const SOURCE_BY_CAPABILITY: Record<PersonalResearchOperationCapability, string> = {
  "flight.search": "personal-research/flight.search",
  "hotel.search": "personal-research/hotel.search",
  "accommodation.discovery": "personal-research/accommodation.discovery",
  "activities.search": "personal-research/activities.search",
  "places.search": "personal-research/places.search",
  "navigation.route": "personal-research/navigation.route",
  "mobility.search": "personal-research/mobility.search",
};

/**
 * Maps the typed draft's `kind` discriminant to the corresponding
 * `PersonalResearchCapability` value used by the DB column. Adding a new
 * capability requires extending this switch and the Zod discriminated union
 * in `types/schemas.ts` in the same change.
 */
function capabilityForDraft(draft: PersonalResearchOwnerDraft): PersonalResearchOperationCapability {
  switch (draft.kind) {
    case "FLIGHT_SEARCH": return "flight.search";
    case "HOTEL_SEARCH": return "hotel.search";
    case "ACCOMMODATION_DISCOVERY": return "accommodation.discovery";
    case "ACTIVITIES_SEARCH": return "activities.search";
    case "PLACES_SEARCH": return "places.search";
    case "NAVIGATION_ROUTE": return "navigation.route";
    case "MOBILITY_SEARCH": return "mobility.search";
  }
}

export type UnavailableErrorCode =
  | "NOT_CONFIGURED"
  | "SEARCH_CONSTRAINTS_INCOMPLETE"
  | "NO_RESULTS"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_FAILURE"
  | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_NOT_APPROVED";

export interface PersonalResearchExecutorResult {
  evidenceId: string;
  outcome: "AVAILABLE" | "UNAVAILABLE";
  summary: PersonalResearchEvidenceSummary;
}

/**
 * Single entry point invoked from `handlePersonalResearchTask`. Validates
 * the capability is currently allowed by the runtime allow-list, picks the
 * executor, and persists the bounded summary to `personal_research_evidence`.
 *
 * The function never throws on a provider failure — the caller receives a
 * `{ outcome: "UNAVAILABLE", summary }` payload that includes the typed
 * errorCode. Anything else (DB constraint, lease lost, programmer error)
 * propagates.
 */
export async function executePersonalResearch(params: {
  run: AgentTaskRow;
  draft: PersonalResearchOwnerDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchExecutorResult> {
  const capability = capabilityForDraft(params.draft);
  if (!isPersonalResearchCapabilityAllowed(capability)) {
    return persistUnavailability({
      run: params.run,
      capability,
      errorCode: "PROVIDER_NOT_APPROVED",
    });
  }

  try {
    const summary = await dispatchCapability(params);
    return persistAvailability({
      run: params.run,
      capability,
      summary,
    });
  } catch (err) {
    const errorCode = mapExecutorErrorToUnavailableCode(err);
    return persistUnavailability({
      run: params.run,
      capability,
      errorCode,
    });
  }
}

async function dispatchCapability(params: {
  run: AgentTaskRow;
  draft: PersonalResearchOwnerDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchEvidenceSummary> {
  switch (params.draft.kind) {
    case "FLIGHT_SEARCH":
      return executePersonalFlightSearch({ run: params.run, draft: params.draft, signal: params.signal });
    case "HOTEL_SEARCH":
      return executePersonalHotelSearch({ run: params.run, draft: params.draft, signal: params.signal });
    // Stage 2/3 capability executors ship in their own PRs (spec §3.5). The
    // runtime allow-list gate above prevents the route from ever reaching
    // this branch with a non-flight kind.
    case "ACCOMMODATION_DISCOVERY":
    case "ACTIVITIES_SEARCH":
    case "PLACES_SEARCH":
    case "NAVIGATION_ROUTE":
    case "MOBILITY_SEARCH":
      throw new ExecutorNotImplementedError(params.draft.kind);
  }
}

export class ExecutorNotImplementedError extends Error {
  constructor(kind: string) {
    super(`Personal research executor not implemented for kind ${kind}`);
    this.name = "ExecutorNotImplementedError";
  }
}

function mapExecutorErrorToUnavailableCode(err: unknown): UnavailableErrorCode {
  if (err instanceof Error && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") {
      const allowed: UnavailableErrorCode[] = [
        "NOT_CONFIGURED",
        "SEARCH_CONSTRAINTS_INCOMPLETE",
        "NO_RESULTS",
        "RATE_LIMITED",
        "UPSTREAM_TIMEOUT",
        "UPSTREAM_FAILURE",
        "INVALID_PROVIDER_RESPONSE",
        "PROVIDER_NOT_APPROVED",
      ];
      if ((allowed as string[]).includes(code)) return code as UnavailableErrorCode;
    }
  }
  return "UPSTREAM_FAILURE";
}

async function persistAvailability(params: {
  run: AgentTaskRow;
  capability: PersonalResearchOperationCapability;
  summary: PersonalResearchEvidenceSummary;
}): Promise<PersonalResearchExecutorResult> {
  if (params.run.tripId === null || params.run.threadId === null) {
    throw new Error("Personal research run is missing trip/thread binding");
  }
  const [row] = await db.insert(personalResearchEvidence).values({
    runId: params.run.id,
    tripId: params.run.tripId,
    threadId: params.run.threadId,
    ownerUserId: params.run.createdByUserId,
    capability: params.capability,
    outcome: "AVAILABLE",
    providerName: PROVIDER_NAME_BY_CAPABILITY[params.capability],
    source: SOURCE_BY_CAPABILITY[params.capability],
    expiresAt: computeExpiresAt(),
    resultJson: params.summary as unknown as Record<string, unknown>,
  }).returning({ id: personalResearchEvidence.id });
  return {
    evidenceId: row.id,
    outcome: "AVAILABLE",
    summary: params.summary,
  };
}

async function persistUnavailability(params: {
  run: AgentTaskRow;
  capability: PersonalResearchOperationCapability;
  errorCode: UnavailableErrorCode;
}): Promise<PersonalResearchExecutorResult> {
  if (params.run.tripId === null || params.run.threadId === null) {
    throw new Error("Personal research run is missing trip/thread binding");
  }
  const summary: PersonalResearchEvidenceSummary = {
    outcome: "UNAVAILABLE",
    summary: { errorCode: params.errorCode },
  };
  const [row] = await db.insert(personalResearchEvidence).values({
    runId: params.run.id,
    tripId: params.run.tripId,
    threadId: params.run.threadId,
    ownerUserId: params.run.createdByUserId,
    capability: params.capability,
    outcome: "UNAVAILABLE",
    providerName: PROVIDER_NAME_BY_CAPABILITY[params.capability],
    source: SOURCE_BY_CAPABILITY[params.capability],
    expiresAt: null,
    resultJson: summary as unknown as Record<string, unknown>,
  }).returning({ id: personalResearchEvidence.id });
  return {
    evidenceId: row.id,
    outcome: "UNAVAILABLE",
    summary,
  };
}

function computeExpiresAt(): Date {
  // Default: 30 minutes for any AVAILABLE evidence. Real providers carry
  // provider-specific freshness windows; the bounded summary does not.
  // Future work may propagate `expiresAt` from `FlightOfferExpiryProvenance`
  // for flight and from the Nuitee cache TTL for hotel.
  return new Date(Date.now() + 30 * 60_000);
}

/**
 * Read the latest evidence row for a run, scoped to the owner.
 * Cross-user reads return null even if a row exists.
 */
export async function readPersonalResearchEvidence(params: {
  runId: string;
  ownerUserId: string;
}): Promise<{
  evidenceId: string;
  capability: PersonalResearchOperationCapability;
  outcome: "AVAILABLE" | "UNAVAILABLE" | "EXPIRED";
  providerName: string;
  source: string;
  capturedAt: Date;
  expiresAt: Date | null;
  summary: PersonalResearchEvidenceSummary;
} | null> {
  const [row] = await db.select().from(personalResearchEvidence).where(and(
    eq(personalResearchEvidence.runId, params.runId),
    eq(personalResearchEvidence.ownerUserId, params.ownerUserId),
  )).orderBy(desc(personalResearchEvidence.createdAt)).limit(1);
  if (!row) return null;
  return {
    evidenceId: row.id,
    capability: row.capability,
    outcome: row.outcome,
    providerName: row.providerName,
    source: row.source,
    capturedAt: row.capturedAt,
    expiresAt: row.expiresAt,
    summary: row.resultJson as unknown as PersonalResearchEvidenceSummary,
  };
}

/**
 * Internal helper for tests / route handlers that need to project the draft
 * back into the canonical capability key. Re-exported so the route layer can
 * validate the allow-list gate against the persisted draft.
 */
export { capabilityForDraft };

/**
 * Re-export of `agentTaskRuns` to keep the existing module surface stable
 * for downstream consumers that may import it from here.
 */
export { agentTaskRuns };