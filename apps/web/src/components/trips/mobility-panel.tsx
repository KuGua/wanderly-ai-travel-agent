"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { MobilityOffer, MobilityServiceType } from "@/lib/api/contracts";

/**
 * Phase 5 — MobilityPanel.
 *
 * Renders persisted mobility offers for the trip. The component is
 * deliberately inert with respect to booking: it exposes a "Select"
 * action that maps to the booking-sandbox gate (Phase 5 §6 hard gate),
 * not to a direct provider call. The web never receives or renders a
 * `bookingUrl` field — that boundary is enforced on the server.
 */
export interface MobilityPanelProps {
  offers: MobilityOffer[];
  onSelect?: (input: { offer: MobilityOffer }) => void;
  onDismiss?: (offerId: string) => void;
  busy?: boolean;
}

const SERVICE_TYPES: MobilityServiceType[] = ["TAXI", "TRANSFER", "CHARTER", "RENTAL"];

export function MobilityPanel({ offers, onSelect, onDismiss, busy = false }: MobilityPanelProps) {
  const t = useTranslations("trips.workspace.mobility");
  const [filter, setFilter] = useState<MobilityServiceType | "ALL">("ALL");
  const filtered = offers.filter((o) => filter === "ALL" || o.serviceType === filter);
  if (offers.length === 0) return null;
  return (
    <section className="wanderly-edge wanderly-r-md wanderly-shadow bg-[var(--w-fog)] p-3 flex flex-col gap-3" aria-busy={busy}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <span className="text-[10px] text-[var(--w-muted)]">{t("attribution")}</span>
      </header>
      <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("filter")}>
        {(["ALL", ...SERVICE_TYPES] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={`text-[11px] px-2 py-0.5 rounded-full ${filter === key ? "bg-[var(--w-ink)] text-[var(--w-bg)]" : "bg-card text-[var(--w-muted)]"}`}
            onClick={() => setFilter(key)}
          >
            {t(`filter.${key.toLowerCase()}`)}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="text-xs text-[var(--w-muted)]">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((offer) => (
            <li key={offer.offerId}>
              <MobilityOfferRow offer={offer} onSelect={onSelect} onDismiss={onDismiss} busy={busy} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MobilityOfferRow({
  offer,
  onSelect,
  onDismiss,
  busy,
}: {
  offer: MobilityOffer;
  onSelect?: (input: { offer: MobilityOffer }) => void;
  onDismiss?: (offerId: string) => void;
  busy: boolean;
}) {
  const t = useTranslations("trips.workspace.mobility");
  const isExpired = offer.expiresAt ? new Date(offer.expiresAt).getTime() <= Date.now() : false;
  return (
    <article className="wanderly-edge wanderly-r-sm wanderly-shadow-sm bg-card p-2 flex flex-col gap-1">
      <header className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{t(`serviceType.${offer.serviceType.toLowerCase()}`)} · {offer.vehicleClass}</span>
        {isExpired ? (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-900">
            {t("expired")}
          </span>
        ) : null}
      </header>
      <p className="text-xs">
        <b className="font-mono">{formatPrice(offer.estimatedPrice, offer.currency)}</b>
        <span className="text-[var(--w-muted)]"> · {t("passengers", { count: offer.passengers })}</span>
      </p>
      <p className="text-[10px] text-[var(--w-muted)] font-mono">{offer.departureAt}</p>
      <footer className="flex gap-2 mt-1">
        {onSelect ? (
          <button
            type="button"
            className="wanderly-btn-primary"
            onClick={() => onSelect({ offer })}
            disabled={busy || isExpired}
          >
            {t("select")}
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            className="wanderly-btn-secondary"
            onClick={() => onDismiss(offer.offerId)}
            disabled={busy}
          >
            {t("dismiss")}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function formatPrice(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}
