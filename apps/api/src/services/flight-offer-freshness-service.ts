import { and, eq } from "drizzle-orm";
import { db } from "../db/database.js";
import { providerOffers } from "../db/schema.js";
import { recordAudit } from "./audit-service.js";
import { metrics } from "../observability/metrics.js";
import type { RequestContext } from "../utils/context.js";
import type { FlightOfferExpiryProvenance } from "../types/domain.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type FlightOfferStalenessReason = "EXPIRED" | "MISSING_EXPIRY" | "UNVERIFIABLE_EXPIRY";

export class FlightOfferStaleError extends Error {
  readonly statusCode: 409 | 422;
  readonly code = "FLIGHT_OFFER_STALE";
  readonly reason: FlightOfferStalenessReason;

  constructor(reason: FlightOfferStalenessReason, message: string) {
    super(message);
    this.name = "FlightOfferStaleError";
    this.reason = reason;
    // EXPIRED is a timing race (the world moved since the plan was proposed);
    // the other two are a persistent data/capability gap, not a race —
    // matching PlanningDataUnavailableError's 422 convention.
    this.statusCode = reason === "EXPIRED" ? 409 : 422;
  }
}

/**
 * Spec §6.2 — before confirmation/adoption and again immediately before
 * booking sandbox execution, every flight offer selected by the plan must be
 * revalidated against authoritative persisted state. Never accepts a
 * client/model-supplied expiry; always reads `provider_offers.expires_at`
 * fresh from the database (or the caller's transaction, for atomicity with
 * the state mutation that follows).
 *
 * Authority comes from the persisted `expiry_provenance` column, never from
 * `provider_name`. Only `PROVIDER_VERIFIED` (the supplier itself returned a
 * ticketing deadline — e.g. Amadeus `lastTicketingDate`) may pass the plain
 * expiry-vs-now comparison. `SYNTHETIC` (a locally-invented cache-freshness
 * heuristic — always the case for SerpAPI/FlightAPI, and Amadeus's own
 * fallback when a specific offer lacks `lastTicketingDate`) and `NULL`
 * (historical rows predating this column, or any other unrecognized value)
 * both fail closed as `UNVERIFIABLE_EXPIRY` regardless of the timestamp's
 * value — a persisted row cannot be upgraded to trusted after the fact, and
 * `provider_name === "amadeus"` alone is never sufficient proof.
 *
 * A plan with zero flight-category offers (e.g. a Personal research run that
 * never requested the "flight" capability) is not this validator's concern —
 * it passes through as vacuously fresh. Shared PLAN/REPLAN already can't
 * reach PROPOSED without non-empty flight coverage
 * (`validateProviderCoverage`), so this only matters when flight offers do
 * exist and must still be checked for having gone stale since they were
 * captured.
 *
 * Throws `FlightOfferStaleError` and — before throwing — records the
 * `FLIGHT_OFFER_EXPIRED` audit action and increments
 * `flight_offer_staleness_total{reason}` on the first offer that fails.
 */
export async function validateSelectedFlightOffersFresh(params: {
  ctx: RequestContext;
  planId: string;
  tripId: string;
  tx?: Tx;
  now?: Date;
}): Promise<void> {
  const client = params.tx ?? db;
  const now = params.now ?? new Date();

  const offers = await client.select({
    id: providerOffers.id,
    providerName: providerOffers.providerName,
    expiresAt: providerOffers.expiresAt,
    expiryProvenance: providerOffers.expiryProvenance,
  }).from(providerOffers).where(and(
    eq(providerOffers.planId, params.planId),
    eq(providerOffers.category, "flight"),
  ));

  for (const offer of offers) {
    const reason = classifyStaleness(offer, now);
    if (!reason) continue;

    metrics.inc("flight_offer_staleness_total", { reason: reason.toLowerCase() });
    // §8 of the authoritative doc names exactly one audit action for this
    // whole area — no sibling name is offered for "missing" or
    // "unverifiable" — so one FLIGHT_OFFER_EXPIRED action covers all three
    // reasons by design, not by omission; `summary.reason` and the metric
    // above carry the specific distinction for anyone reading the log.
    await recordAudit({
      ctx: params.ctx,
      action: "FLIGHT_OFFER_EXPIRED",
      tripId: params.tripId,
      planId: params.planId,
      summary: {
        provider: offer.providerName,
        reason,
        expiryProvenance: offer.expiryProvenance,
        serverObservedExpiry: offer.expiresAt ? offer.expiresAt.toISOString() : null,
        serverTime: now.toISOString(),
      },
      tx: params.tx,
    });

    throw new FlightOfferStaleError(
      reason,
      reason === "EXPIRED"
        ? "A selected flight offer has expired and must be re-searched before this plan can proceed"
        : reason === "UNVERIFIABLE_EXPIRY"
          ? `The ${offer.providerName} flight offer's expiry cannot be verified against the supplier and must be re-searched`
          : "A selected flight offer is missing a verifiable expiry and must be re-searched",
    );
  }
}

function classifyStaleness(
  offer: { providerName: string; expiresAt: Date | null; expiryProvenance: string | null },
  now: Date,
): FlightOfferStalenessReason | null {
  const provenance = offer.expiryProvenance as FlightOfferExpiryProvenance | null;
  if (provenance !== "PROVIDER_VERIFIED") return "UNVERIFIABLE_EXPIRY";
  if (!offer.expiresAt) return "MISSING_EXPIRY";
  if (offer.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return null;
}
