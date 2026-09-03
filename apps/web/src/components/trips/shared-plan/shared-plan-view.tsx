"use client";

import { useTranslations } from "next-intl";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { TravelApiError } from "@/lib/api/errors";
import { useTripPlans } from "@/lib/query/hooks";

/**
 * Shared Plan Surface — Phase 1 read-only skeleton.
 *
 * Five top-level states (§7.2 in
 * docs/shared-plan-surface-implementation.md):
 *   a. Empty          — no run, no plans in any grouping.
 *   b. In progress    — active `run.status`; built in Phase 2.
 *   c. Has plan       — proposed/active/stale present; built in Phase 3.
 *   d. Failed         — terminal errorCode; built in Phase 2/3.
 *   e. No access      — 403/410 from any of the four member-scoped reads.
 *
 * Phase 1 implements a, loading, error, e. Phase 2 wires SSE-driven status
 * text; Phase 3 brings in proposal cards, version trail, vote controls.
 *
 * Authorisation: the four REST reads (`useTripPlans`, `useLatestPlanningRun`,
 * `useTripConstraintsForMembers`, `usePlanAdoptionVotes`) are themselves
 * member-scoped on the server — this view never reproduces that check. A
 * non-member is rejected upstream and surfaces here as 403/410 → state e.
 */
export function SharedPlanView({ tripId }: { tripId: string }) {
  const t = useTranslations("trips.sharedPlan");
  const plansQuery = useTripPlans(tripId);

  // Loading: any of the four reads still in flight.
  if (plansQuery.isLoading) {
    return <LoadingState label={t("empty.title")} />;
  }

  // Error: 403/410 → membership revoked; other failures → generic.
  // We render the revoked state inline rather than going through
  // `ErrorState` because `ErrorState` overrides the `title` prop when the
  // error is unauthorized — and the spec mandates a specific message
  // distinct from the generic "Access unavailable" copy.
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
  if (empty) {
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

  // Phase 3+ will replace this stub with the proposal-card list, version
  // trail, constraints panel, and adoption vote. Until then the view shows
  // a minimal grouped count to confirm the read pipeline works.
  return (
    <section aria-label={t("headerTitle")} className="grid gap-3 p-2">
      <p className="text-sm font-bold">{t("headerTitle")}</p>
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
    </section>
  );
}