"use client";

import { useTranslations } from "next-intl";
import type { PlaceCandidate, TripPlace, TripPlaceKind, TripPlaceVisibility } from "@/lib/api/contracts";

/**
 * Phase 2 — `PlacesPanel` companion card. Renders a single place candidate
 * with optional `needsUserConfirmation` badge, plus an `Adopt` / `Cancel`
 * action surface that the parent panel wires to its hooks.
 *
 * The component is presentation-only; it does not issue queries or
 * mutations. Coordinates are shown as bounded `{lat}, {lng}` text but the
 * map itself is the inert `TripMiniGlobe`; this card never paints geometry
 * directly.
 */
export interface PlaceCandidateCardProps {
  candidate: PlaceCandidate;
  onAdopt: (input: { candidate: PlaceCandidate; visibility: TripPlaceVisibility; kind: TripPlaceKind }) => void;
  onDismiss: (candidateId: string) => void;
  busy?: boolean;
}

export function PlaceCandidateCard({ candidate, onAdopt, onDismiss, busy = false }: PlaceCandidateCardProps) {
  const t = useTranslations("trips.workspace.poi");
  const coords = `${candidate.latitude.toFixed(3)}, ${candidate.longitude.toFixed(3)}`;
  const kindLabel = t(`kind.${candidate.kind}`);
  return (
    <article className="wanderly-edge wanderly-r-md wanderly-shadow bg-[var(--w-fog)] p-4 flex flex-col gap-2" aria-busy={busy}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold leading-tight">{candidate.displayName}</h3>
          <p className="text-xs text-[var(--w-muted)]">{kindLabel}</p>
          {candidate.cityName || candidate.countryCode ? (
            <p className="text-xs text-[var(--w-muted)]">
              {[candidate.cityName, candidate.countryCode].filter(Boolean).join(" · ")}
            </p>
          ) : null}
        </div>
        {candidate.needsUserConfirmation ? (
          <span
            role="status"
            aria-live="polite"
            className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-900"
          >
            {t("needsConfirmation")}
          </span>
        ) : null}
      </header>
      <p className="text-xs text-[var(--w-muted)] font-mono">{coords}</p>
      <footer className="flex gap-2 mt-1">
        <button
          type="button"
          className="wanderly-btn-primary"
          onClick={() => onAdopt({ candidate, visibility: "TEAM_VISIBLE", kind: candidate.kind })}
          disabled={busy}
        >
          {t("adopt")}
        </button>
        <button
          type="button"
          className="wanderly-btn-secondary"
          onClick={() => onDismiss(candidate.candidateId)}
          disabled={busy}
        >
          {t("dismiss")}
        </button>
      </footer>
    </article>
  );
}

export interface TripPlaceRowProps {
  place: TripPlace;
  onRevoke: (input: { placeId: string; reason: string }) => void;
  busy?: boolean;
}

export function TripPlaceRow({ place, onRevoke, busy = false }: TripPlaceRowProps) {
  const t = useTranslations("trips.workspace.poi");
  const statusBadge =
    place.status === "ACTIVE" ? t("status.active") :
    place.status === "PROPOSED" ? t("status.proposed") :
    t("status.revoked");
  const visibilityBadge = t(`visibility.${place.visibility.toLowerCase()}`);
  return (
    <article className="wanderly-edge wanderly-r-md wanderly-shadow bg-[var(--w-fog)] p-3 flex items-center justify-between gap-3" aria-busy={busy}>
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-sm font-medium truncate">{place.displayName}</span>
        <span className="text-xs text-[var(--w-muted)]">
          {t(`kind.${place.kind}`)} · {visibilityBadge} · {statusBadge}
        </span>
      </div>
      {place.status !== "REVOKED" ? (
        <button
          type="button"
          className="wanderly-btn-secondary"
          onClick={() => onRevoke({ placeId: place.id, reason: "user_revoked" })}
          disabled={busy}
        >
          {t("revoke")}
        </button>
      ) : null}
    </article>
  );
}