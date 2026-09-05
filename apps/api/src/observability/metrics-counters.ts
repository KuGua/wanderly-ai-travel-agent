/**
 * Offer Cue observability helpers — wraps `metrics.inc` with the
 * label vocabularies registered for `offer_cue_*` and
 * `personal_offer_selection_*` counters. Centralising here keeps the
 * service layer free of metric-label literals and prevents typos that
 * would silently bypass the registry's allowed-label checks.
 *
 * Labels are limited to bounded enums (capability, outcome, action,
 * source). Never include requestId, candidateRef, routeKey/stayKey,
 * ownerUserId, tripId, threadId, or any provider/payload field.
 */

import { metrics } from "./metrics.js";

export type OfferCueCapability = "flight" | "hotel";
export type OfferCueAction = "accept" | "dismiss";
/** Wire enum (matches Zod offerCueActionRequestSchema): uppercase snake. */
export type OfferCueSourceWire = "CARD_BUTTON" | "RESULT_CARD_BUTTON";
/** Metric label enum (lowercase snake, per metrics.ts convention). */
export type OfferCueSource = "card_button" | "result_card_button";

export type OfferCueDecisionOutcome =
  | "created" | "skipped_policy" | "skipped_duplicate" | "skipped_freshness"
  | "skipped_clarification" | "failure" | "no_candidates" | "needs_clarification";

export type OfferCueActionOutcome =
  | "success" | "stale_version" | "not_found" | "forbidden" | "trip_state"
  | "conflict" | "expired" | "failure";

export type OfferCueResolutionOutcome = "resolved" | "superseded" | "expired";
export type PersonalOfferSelectionOutcome = "created" | "superseded" | "removed";

export type OfferCueMetricKind = "decision" | "action" | "resolution" | "selection";

function normalizeSource(source: OfferCueSourceWire | OfferCueSource | undefined): OfferCueSource {
  if (source === "CARD_BUTTON" || source === "card_button") return "card_button";
  return "result_card_button";
}

export function incrementOfferCueMetrics(input: {
  capability: OfferCueCapability;
  metric: OfferCueMetricKind;
  outcome: string;
  action?: OfferCueAction;
  source?: OfferCueSourceWire | OfferCueSource;
}): void {
  switch (input.metric) {
    case "decision":
      metrics.inc("offer_cue_decision_total", {
        capability: input.capability,
        outcome: input.outcome,
      });
      return;
    case "action":
      metrics.inc("offer_cue_action_total", {
        capability: input.capability,
        action: input.action ?? "accept",
        outcome: input.outcome,
        source: normalizeSource(input.source),
      });
      return;
    case "resolution":
      metrics.inc("offer_cue_resolution_total", {
        capability: input.capability,
        outcome: input.outcome,
      });
      return;
    case "selection":
      metrics.inc("personal_offer_selection_total", {
        capability: input.capability,
        outcome: input.outcome,
      });
      return;
  }
}

export function observeOfferCueResolverDuration(input: {
  capability: OfferCueCapability;
  outcome: "success" | "timeout" | "parse_error" | "upstream_failure" | "client_unavailable";
  durationMs: number;
}): void {
  metrics.observe("offer_cue_resolver_duration_ms", input.durationMs, {
    capability: input.capability,
    outcome: input.outcome,
  });
}
