/**
 * Personal mobility-offer executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls the Amadeus Transfer adapter directly (NEVER the Shared
 * `executeAndPersistMobilitySearch` persistence layer) and projects the
 * result to the bounded `personalResearchMobilityEvidenceSummarySchema`.
 *
 * Provider gate: the executor only runs when `PLAN_ENABLE_MOBILITY=true`.
 * The Shared path enforces the same flag via `mobility-search-service.ts`;
 * the executor mirrors that gate to fail closed when the operator has
 * intentionally disabled mobility. Source:
 * docs/draft-personal-research-implementation.md §3.5 stage 3.
 */

import { createAmadeusTransfer } from "../../providers/live-provider-factory.js";
import type { NormalizedMobilityOffer } from "../../providers/types.js";
import type { PersonalResearchEvidenceSummary } from "../../types/domain.js";
import type { AgentTaskRow } from "../../tasks/task-repository.js";

export type PersonalResearchMobilityDraft = {
  kind: "MOBILITY_SEARCH";
  originPlaceId: string;
  destinationPlaceId: string;
  transferDateTime: string;
  passengers: number;
  currency: string;
};

export async function executePersonalMobilitySearch(params: {
  run: AgentTaskRow;
  draft: PersonalResearchMobilityDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchEvidenceSummary> {
  if (process.env.PLAN_ENABLE_MOBILITY !== "true") {
    return unavailableSummary("NOT_CONFIGURED");
  }
  const provider = createAmadeusTransfer();

  const input = {
    originPlaceId: params.draft.originPlaceId,
    destinationPlaceId: params.draft.destinationPlaceId,
    passengers: params.draft.passengers,
    departureAt: params.draft.transferDateTime,
    serviceType: "TRANSFER" as const,
    snapshotId: "",
    runId: params.run.id,
    signal: params.signal,
  };

  let result: { outcome: "LIVE"; data: NormalizedMobilityOffer[]; source: string; capturedAt: string }
    | { outcome: "UNAVAILABLE"; reason: string };
  try {
    result = await provider.searchOffers(input);
  } catch (err) {
    return unavailableSummaryFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableSummaryFromReason(result.reason);
  }

  const offers = (result.data ?? []) as NormalizedMobilityOffer[];
  return {
    outcome: "AVAILABLE",
    capability: "mobility.search",
    mobility: {
      offerCount: offers.length,
      currency: params.draft.currency,
      transferDateTime: params.draft.transferDateTime,
      passengers: params.draft.passengers,
    },
  };
}

type UnavailableCode =
  | "NOT_CONFIGURED"
  | "SEARCH_CONSTRAINTS_INCOMPLETE"
  | "NO_RESULTS"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_FAILURE"
  | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_NOT_APPROVED";

const ALLOWED_UNAVAILABLE_CODES: UnavailableCode[] = [
  "NOT_CONFIGURED",
  "SEARCH_CONSTRAINTS_INCOMPLETE",
  "NO_RESULTS",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_FAILURE",
  "INVALID_PROVIDER_RESPONSE",
  "PROVIDER_NOT_APPROVED",
];

function unavailableSummary(errorCode: UnavailableCode): PersonalResearchEvidenceSummary {
  return { outcome: "UNAVAILABLE", summary: { errorCode } };
}

function unavailableSummaryFromReason(reason: string): PersonalResearchEvidenceSummary {
  if ((ALLOWED_UNAVAILABLE_CODES as string[]).includes(reason)) {
    return unavailableSummary(reason as UnavailableCode);
  }
  return unavailableSummary("UPSTREAM_FAILURE");
}

function unavailableSummaryFromError(err: unknown): PersonalResearchEvidenceSummary {
  if (err instanceof Error && err.name === "AbortError") return unavailableSummary("UPSTREAM_TIMEOUT");
  return unavailableSummary("UPSTREAM_FAILURE");
}