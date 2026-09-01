"use client";

import { useTranslations } from "next-intl";

import type { ConversationHotelOffer } from "@/lib/api/contracts";

/**
 * One line item from a live `hotel.search` tool result, rendered inline in
 * the chat panel right under the "Finding hotels" activity row.
 *
 * Named distinctly from `HotelOfferCard` (the richer Shared-planning card):
 * this mirrors the bounded `topOffers` shape the server persists — property
 * name, per-night price, cancellation summary — no booking link, offer id,
 * or raw provider payload.
 */
export interface SearchHotelOfferCardProps {
  offer: ConversationHotelOffer;
  /** Single currency for the whole search — not part of the per-offer shape. */
  currency: string;
}

export function SearchHotelOfferCard({ offer, currency }: SearchHotelOfferCardProps) {
  const t = useTranslations("trips.hotel.searchCard");
  const priceText = formatMoney(offer.pricePerNight, currency);
  return (
    <article
      className="wanderly-edge wanderly-r-md wanderly-shadow bg-white p-3 flex flex-col gap-1.5 text-sm"
      data-testid="search-hotel-offer-card"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="font-semibold text-sm">{offer.propertyName}</h4>
        <span className="font-semibold text-base">{priceText}</span>
      </header>
      <p className="text-xs text-slate-500">{t("perNightLabel")}</p>
      {offer.cancellationSummary ? (
        <p className="text-xs text-slate-600">{offer.cancellationSummary}</p>
      ) : null}
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
