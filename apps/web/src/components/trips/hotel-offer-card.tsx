"use client";

import { useTranslations } from "next-intl";

import type { HotelOfferDto } from "@/lib/api/contracts";

/** Local re-export of the tax-fee status union. */

/**
 * Phase E — minimum hotel comparison card.
 *
 * Renders a single offer with source attribution and tax-fee handling.
 * - `INCLUDED` shows no extra disclaimer.
 * - `PARTIAL` / `UNKNOWN` show "可能另计" / "taxes may apply" disclaimer.
 *
 * Sensitive supplier fields (raw offerId, hotel URL, address, image URLs,
 * nationality) are NEVER rendered here. The DTO is provider-neutral so
 * swapping HOTEL_PROVIDER never breaks the card.
 */
export interface HotelOfferCardProps {
  offer: HotelOfferDto;
}

export function HotelOfferCard({ offer }: HotelOfferCardProps) {
  const t = useTranslations("trips.hotel.card");
  const totalText = formatMoney(offer.totalPrice, offer.currency);
  const perNightText = formatMoney(offer.pricePerNight, offer.currency);
  const showDisclaimer = offer.taxesAndFees.status !== "INCLUDED";
  return (
    <article
      className="wanderly-edge wanderly-r-md wanderly-shadow bg-white p-4 flex flex-col gap-2 text-sm"
      data-testid="hotel-offer-card"
      data-provider={offer.providerName}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="font-semibold text-base">{offer.propertyName}</h4>
        <span className="text-xs text-slate-500">{offer.source}</span>
      </header>
      {offer.roomSummary ? (
        <p className="text-xs text-slate-600">{offer.roomSummary}</p>
      ) : null}
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-slate-500">{t("totalLabel")}</dt>
          <dd className="font-semibold text-base">{totalText}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{t("perNightLabel")}</dt>
          <dd>{perNightText}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{t("nightsLabel")}</dt>
          <dd>{offer.nights}</dd>
        </div>
        <div>
          <dt className="text-slate-500">{t("occupancyLabel")}</dt>
          <dd>{offer.adultsPerRoom.join(" + ")}</dd>
        </div>
      </dl>
      {offer.cancellationSummary ? (
        <p className="text-xs text-slate-600">{offer.cancellationSummary}</p>
      ) : null}
      {showDisclaimer ? (
        <p className="text-xs text-amber-700" data-testid="hotel-tax-disclaimer">
          {t("taxFeeDisclaimer")}
        </p>
      ) : null}
      <footer className="text-[10px] text-slate-400">
        {t("capturedAtLabel", { value: new Date(offer.capturedAt).toISOString() })}
      </footer>
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

export type HotelTaxFeeStatus = "INCLUDED" | "PARTIAL" | "UNKNOWN";
