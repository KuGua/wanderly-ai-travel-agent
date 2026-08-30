"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { NavigationRouteMode, RouteEvidence } from "@/lib/api/contracts";

/**
 * Phase 3 — RouteEvidenceCard.
 *
 * Renders a persisted navigation route. The full encoded geometry is
 * intentionally NOT shipped here; the trip-side interactive map is the
 * inert `TripMiniGlobe`, and route geometry for the full map is loaded
 * via the snapshot-bound `route-evidence` DTO and rendered by the explorer's
 * AttributionControl'd MapLibre layer.
 */
export interface RouteEvidenceCardProps {
  route: RouteEvidence;
  originLabel?: string;
  destinationLabel?: string;
  onRefresh?: (routeId: string) => void;
  busy?: boolean;
}

const MAX_VISIBLE_STEPS = 8;

export function RouteEvidenceCard({ route, originLabel, destinationLabel, onRefresh, busy = false }: RouteEvidenceCardProps) {
  const t = useTranslations("trips.workspace.route");
  const distance = formatMeters(route.distanceMeters);
  const duration = formatSeconds(route.durationSeconds);
  const visibleSteps = route.steps.slice(0, MAX_VISIBLE_STEPS);
  const truncated = route.steps.length - visibleSteps.length;
  const [renderedAt] = useState(Date.now);
  const isStale = new Date(route.refreshAfter).getTime() <= renderedAt;
  return (
    <article className="wanderly-edge wanderly-r-md wanderly-shadow bg-[var(--w-fog)] p-3 flex flex-col gap-2" aria-busy={busy}>
      <header className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="text-sm font-semibold truncate">
            {t("title", {
              origin: originLabel ?? t("originFallback"),
              destination: destinationLabel ?? t("destinationFallback"),
            })}
          </h3>
          <p className="text-xs text-[var(--w-muted)]">{t(`mode.${route.mode}`)}</p>
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${isStale ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-900"}`}>
          {isStale ? t("stale") : t("fresh")}
        </span>
      </header>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex flex-col">
          <dt className="text-[var(--w-muted)]">{t("distance")}</dt>
          <dd className="font-mono">{distance}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-[var(--w-muted)]">{t("duration")}</dt>
          <dd className="font-mono">{duration}</dd>
        </div>
      </dl>
      <ol className="flex flex-col gap-1 text-xs">
        {visibleSteps.map((step) => (
          <li key={step.index} className="flex items-start gap-2">
            <span className="text-[var(--w-muted)] font-mono w-5 text-right">{step.index + 1}.</span>
            <span>{step.instruction}</span>
          </li>
        ))}
        {truncated > 0 ? (
          <li className="text-[var(--w-muted)]">{t("stepsTruncated", { count: truncated })}</li>
        ) : null}
      </ol>
      <footer className="flex items-center justify-between gap-2 text-[10px] text-[var(--w-muted)]">
        <span>{t("attribution")}</span>
        {onRefresh ? (
          <button
            type="button"
            className="wanderly-btn-secondary"
            onClick={() => onRefresh(route.id)}
            disabled={busy}
          >
            {t("refresh")}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

function formatMeters(m: number): string {
  if (m >= 1_000) return `${(m / 1_000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

function formatSeconds(s: number): string {
  if (s >= 3_600) {
    const hours = Math.floor(s / 3_600);
    const minutes = Math.round((s - hours * 3_600) / 60);
    return `${hours} h ${minutes} min`;
  }
  if (s >= 60) return `${Math.round(s / 60)} min`;
  return `${Math.round(s)} s`;
}

export function modeLabelKey(mode: NavigationRouteMode): string {
  return `mode.${mode}`;
}
