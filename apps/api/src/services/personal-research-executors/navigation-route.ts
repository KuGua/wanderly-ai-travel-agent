/**
 * Personal navigation-route executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls the ORS Navigation adapter directly (NEVER the Shared
 * `executeAndPersistNavigationRoute` persistence layer) and projects the
 * result to the bounded `personalResearchNavigationRouteEvidenceSummarySchema`.
 *
 * Privacy: the executor NEVER carries commercial fare, schedules, or
 * carrier-specific metadata. The summary exposes only geometry + distance
 * + duration + mode — same shape the Shared path uses for the audit log
 * strip. Source: docs/draft-personal-research-implementation.md §3.5
 * stage 3.
 */

import { createOrsNavigation } from "../../providers/live-provider-factory.js";
import type {
  NormalizedRouteEvidence,
} from "../../providers/types.js";
import type { PersonalResearchEvidenceSummary } from "../../types/domain.js";
import type { AgentTaskRow } from "../../tasks/task-repository.js";

export type PersonalResearchNavigationRouteDraft = {
  kind: "NAVIGATION_ROUTE";
  originPlaceId: string;
  destinationPlaceId: string;
  mode: "driving" | "walking" | "cycling";
};

export async function executePersonalNavigationRoute(params: {
  run: AgentTaskRow;
  draft: PersonalResearchNavigationRouteDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchEvidenceSummary> {
  const provider = createOrsNavigation();

  const input = {
    originPlaceId: params.draft.originPlaceId,
    destinationPlaceId: params.draft.destinationPlaceId,
    // Normalize Personal mode spelling (driving / walking / cycling) to the
    // Shared provider's WALK / DRIVE / CYCLE enum.
    mode: normalizeMode(params.draft.mode),
    snapshotId: "",
    runId: params.run.id,
    signal: params.signal,
  };

  let result: { outcome: "LIVE"; data: NormalizedRouteEvidence; source: string; capturedAt: string }
    | { outcome: "UNAVAILABLE"; reason: string };
  try {
    result = await provider.searchRoute(input);
  } catch (err) {
    return unavailableSummaryFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableSummaryFromReason(result.reason);
  }

  const route = result.data;
  return {
    outcome: "AVAILABLE",
    capability: "navigation.route",
    navigation: {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      mode: params.draft.mode,
    },
  };
}

function normalizeMode(mode: "driving" | "walking" | "cycling"): "WALK" | "DRIVE" | "CYCLE" {
  switch (mode) {
    case "driving": return "DRIVE";
    case "walking": return "WALK";
    case "cycling": return "CYCLE";
  }
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