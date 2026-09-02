/**
 * Personal activities-search executor.
 *
 * Owner-only typed input from the DRAFT Personal Research confirm path.
 * Calls the Viator MCP adapter directly (NEVER the Shared activities
 * search persistence layer) and projects the result to the bounded
 * `personalResearchActivitiesEvidenceSummarySchema` shape.
 *
 * Privacy: the summary exposes activity count + currency + destination
 * + date range. It deliberately OMITS per-activity price, supplier, and
 * booking URL — the Shared path on activate re-queries the provider for
 * the full offer set so the Personal path cannot seed plan evidence.
 *
 * Source: docs/draft-personal-research-implementation.md §3.5 stage 2.
 */

import { createActivitiesProvider } from "../../providers/live-provider-factory.js";
import type { ActivityProviderItem } from "../../providers/types.js";
import type { PersonalResearchEvidenceSummary } from "../../types/domain.js";
import type { AgentTaskRow } from "../../tasks/task-repository.js";
import { PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT } from "../../types/schemas.js";

export type PersonalResearchActivitiesDraft = {
  kind: "ACTIVITIES_SEARCH";
  destinationCode: string;
  startDate: string;
  endDate: string;
  category: string | null;
  limit: number | null;
};

export async function executePersonalActivitiesSearch(params: {
  run: AgentTaskRow;
  draft: PersonalResearchActivitiesDraft;
  signal: AbortSignal;
}): Promise<PersonalResearchEvidenceSummary> {
  const provider = createActivitiesProvider();

  const input = {
    destination: params.draft.destinationCode,
    dateStart: params.draft.startDate,
    dateEnd: params.draft.endDate,
    locale: "en" as const,
    currency: "USD",
    limit: params.draft.limit ?? 20,
    signal: params.signal,
  };

  let result: { outcome: "LIVE"; data: ActivityProviderItem[]; source: string; capturedAt: string }
    | { outcome: "UNAVAILABLE"; reason: string };
  try {
    result = await provider.searchActivities(input);
  } catch (err) {
    return unavailableSummaryFromError(err);
  }

  if (result.outcome === "UNAVAILABLE") {
    return unavailableSummaryFromReason(result.reason);
  }

  const items = (result.data ?? []) as ActivityProviderItem[];
  // `fromPrice` is a required field on every item, denominated in the
  // currency the search asked for. This used to be hardcoded null, from
  // before activities carried a stated price at all; the summary reported no
  // band while every item had one, so the result card could only ever show
  // a dash.
  const prices = items.map((item) => item.fromPrice).filter((price) => Number.isFinite(price));
  const minPrice: number | null = prices.length > 0 ? Math.min(...prices) : null;
  const maxPrice: number | null = prices.length > 0 ? Math.max(...prices) : null;

  return {
    outcome: "AVAILABLE",
    capability: "activities.search",
    activities: {
      // Titles and per-person prices. The band alone could not name a single
      // thing to do.
      items: items.slice(0, PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT).map((item) => ({
        label: item.title,
        price: Number.isFinite(item.fromPrice) && item.currency
          ? { amount: item.fromPrice, currency: item.currency, unit: "PER_PERSON" as const }
          : null,
        detail: [item.category, item.rating === null ? null : `★${item.rating.toFixed(1)}`]
          .filter(Boolean).join(" · ") || null,
      })),
      activityCount: items.length,
      currency: items[0]?.currency ?? "USD",
      destinationCode: params.draft.destinationCode,
      startDate: params.draft.startDate,
      endDate: params.draft.endDate,
      minPrice,
      maxPrice,
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