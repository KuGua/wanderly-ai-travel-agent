"use client";

import { useTranslations } from "next-intl";

import type { ConversationFlightOffer } from "@/lib/api/contracts";

/**
 * One line item from a live `flight.search` tool result, rendered inline in
 * the chat panel right under the "Checking flights" activity row.
 *
 * Deliberately minimal: this mirrors the bounded `topOffers` shape the
 * server persists (carrier, times, duration, price, stop count) — no
 * booking link, no offer id, no raw provider payload.
 */
export interface FlightOfferCardProps {
  offer: ConversationFlightOffer;
  /** Single currency for the whole search — not part of the per-offer shape. */
  currency: string;
}

export function FlightOfferCard({ offer, currency }: FlightOfferCardProps) {
  const t = useTranslations("trips.flight.card");
  const priceText = formatMoney(offer.totalPrice, currency);
  const departure = formatTime(offer.departureAt);
  const arrival = formatTime(offer.arrivalAt);
  const stopsText = offer.stopCount === 0 ? t("nonstop") : t("stops", { count: offer.stopCount });
  return (
    <article
      className="wanderly-edge wanderly-r-md wanderly-shadow bg-white p-3 flex flex-col gap-1.5 text-sm"
      data-testid="flight-offer-card"
      data-carrier={offer.carrierCode}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="font-semibold text-sm">
          {offer.carrierCode}{offer.flightNumber ? ` ${offer.flightNumber}` : ""}
        </h4>
        <span className="font-semibold text-base">{priceText}</span>
      </header>
      <p className="text-xs text-slate-600">
        {t("timesLine", { departure, arrival })}
      </p>
      <p className="text-xs text-slate-500">
        {t("durationLine", { duration: offer.totalDuration.replace(/^PT/, "").toLowerCase() })} · {stopsText}
      </p>
    </article>
  );
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(0)}`;
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
