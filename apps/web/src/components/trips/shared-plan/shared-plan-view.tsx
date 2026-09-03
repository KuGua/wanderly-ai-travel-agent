"use client";

import { useTranslations } from "next-intl";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { TravelApiError } from "@/lib/api/errors";
import { useSharedPlanFeed, useTripPlans } from "@/lib/query/hooks";
import { SharedPlanStatusBar } from "./shared-plan-status-bar";

/**
 * Shared Plan Surface — Phase 2 wired view.
 *
 * Five top-level states (§7.2 in
 * docs/shared-plan-surface-implementation.md):
 *   a. Empty          — no run, no plans in any grouping.
 *   b. In progress    — active `run.status` shown via the status strip.
 *   c. Has plan       — proposed/active/stale present; full card list
 *                       lands in Phase 3.
 *   d. Failed         — terminal errorCode; Phase 3 maps the errorCode
 *                       to localized copy.
 *   e. No access      — 403/410 from any of the member-scoped reads.
 *
 * Phase 1 implemented a, loading, error, e. Phase 2 adds the status bar
 * (b/c) using the latest run from `useSharedPlanFeed`. SSE subscription
 * lands alongside the rest of the SSE work in Phase 4 (the data is
 * already available via the run query, so the status updates even
 * before SSE is wired).
 *
 * Authorisation: the four REST reads (`useTripPlans`,
 * `useLatestPlanningRun`, `useTripConstraintsForMembers`,
 * `usePlanAdoptionVotes`) are themselves member-scoped on the server —
 * this view never reproduces that check. A non-member is rejected
 * upstream and surfaces here as 403/410 → state e.
 */
export function SharedPlanView({ tripId }: { tripId: string }) {
  const t = useTranslations("trips.sharedPlan");
  const feed = useSharedPlanFeed(tripId);
  const plansQuery = useTripPlans(tripId);

  // Loading: any of the four reads still in flight.
  if (feed.runError && plansQuery.isLoading) {
    // The run endpoint is the first to settle; treat it as authoritative
    // for the loading decision so we don't bounce the user between states.
  }
  if (plansQuery.isLoading || feed.runError === undefined && !feed.run && feed.isBusy) {
    // Initial mount before either query has settled.
    return <LoadingState label={t("empty.title")} />;
  }

  // Error: 403/410 → membership revoked; other failures → generic.
  if (plansQuery.error) {
    const revoked =
      plansQuery.error instanceof TravelApiError
      && (plansQuery.error.isUnauthorized || plansQuery.error.statusCode === 410);
    if (revoked) {
      return (
        <section
          data-testid="shared-plan-forbidden"
          role="alert"
          className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6"
        >
          <h2 className="font-semibold">{t("error.forbidden")}</h2>
        </section>
      );
    }
    return <ErrorState error={plansQuery.error} title={t("error.generic")} />;
  }

  const data = plansQuery.data;
  const empty = !data
    || (data.proposed.length === 0 && data.active.length === 0 && data.stale.length === 0);

  // State a — empty. Phase 1 has no run/lifecycle text; Phase 2 will
  // distinguish "queued, no result yet" from "never triggered". For now
  // there is no manual-replan button (§6 forbidden) — only a pointer
  // back to the caller's private thread where plans are born.
  if (empty && !feed.run) {
    return (
      <section
        data-testid="shared-plan-empty"
        aria-label={t("empty.title")}
        className="flex flex-col gap-3 border-2 border-dashed border-[var(--w-ink)] p-6 text-center wanderly-edge wanderly-r-md"
      >
        <p className="text-base font-bold text-foreground">{t("empty.title")}</p>
        <p className="text-sm text-muted-foreground">{t("empty.body")}</p>
      </section>
    );
  }

  // State b/c — plans present OR a run is in flight. Render the status
  // bar first so the lifecycle is the topmost thing the reader sees,
  // then the (placeholder) plan list. Phase 3 replaces the placeholder
  // with full proposal cards, the version trail, and the vote controls.
  return (
    <section aria-label={t("headerTitle")} className="grid gap-3">
      <SharedPlanStatusBar run={feed.run} />
      {data && (
        <ul className="grid gap-2 text-sm text-muted-foreground">
          {data.proposed.map((p) => (
            <li key={p.id} data-testid="shared-plan-stub-proposed">
              {p.destination} · v{p.version}
            </li>
          ))}
          {data.active.map((p) => (
            <li key={p.id} data-testid="shared-plan-stub-active">
              {p.destination} · v{p.version}
            </li>
          ))}
          {data.stale.map((p) => (
            <li key={p.id} data-testid="shared-plan-stub-stale">
              {p.destination} · v{p.version}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}