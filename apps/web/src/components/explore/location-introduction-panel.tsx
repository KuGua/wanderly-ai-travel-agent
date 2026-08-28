"use client";

import { useTranslations } from "next-intl";

import type { LocationIntroductionState } from "@/lib/query/use-location-introduction";

/**
 * Pure presentation for the cached, non-personalized destination
 * introduction. Renders four states (idle/loading/generating/ready/
 * unavailable). Never exposes an "AI generated" badge, timestamp, or
 * cache-hit attribution — the cached blob is presented as ordinary
 * descriptive copy so it reads as map context, not model output.
 */
export function LocationIntroductionPanel({
  state,
  onRetry,
}: {
  state: LocationIntroductionState;
  onRetry?: () => void;
}) {
  const t = useTranslations("explore");

  if (state.status === "idle") return null;

  if (state.status === "loading") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-3 text-xs text-muted-foreground"
        data-location-introduction-status="loading"
      >
        {t("locationIntroduction.loading")}
      </p>
    );
  }

  if (state.status === "generating") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-3 text-xs text-muted-foreground"
        data-location-introduction-status="generating"
      >
        {t("locationIntroduction.generating")}
      </p>
    );
  }

  if (state.status === "ready") {
    return (
      <p
        className="mt-3 text-sm leading-6 text-foreground/90"
        data-location-introduction-status="ready"
      >
        {state.content}
      </p>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
      data-location-introduction-status="unavailable"
    >
      <span>{t("locationIntroduction.unavailable")}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          {t("locationIntroduction.retry")}
        </button>
      ) : null}
    </div>
  );
}