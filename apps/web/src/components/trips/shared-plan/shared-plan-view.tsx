"use client";

import { useTranslations } from "next-intl";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link } from "@/i18n/navigation";
import { TravelApiError } from "@/lib/api/errors";
import { useLatestResearchResult, useSharedPlanFeed, useTripPlans } from "@/lib/query/hooks";
import { readLastSeenVersion, writeLastSeenVersion } from "@/lib/trips/shared-plan-read-state";
import { PlanProposalCard } from "./plan-proposal-card";
import { PlanVersionTrail } from "./plan-version-trail";
import { SharedPlanStatusBar } from "./shared-plan-status-bar";
import { TeamConstraintsPanel } from "./team-constraints-panel";

/**
 * Shared Plan Surface — Phase 3 full assembly.
 *
 * Renders all five states from §7.2 of
 * docs/shared-plan-surface-implementation.md:
 *   a. Empty          — no run, no plans.
 *   b. In progress    — active run; status bar above plan list.
 *   c. Has plan       — proposed/active/stale present; cards + trail.
 *   d. Failed         — terminal errorCode; surfaced in Phase 4 alongside
 *                       the badge.
 *   e. No access      — 403/410 from any of the four reads.
 *
 * Phase 3 introduces the proposal card (N3), version trail (N4),
 * constraints panel (N5), and removes the placeholder list. SSE
 * subscription is still owed by Phase 4 — the data is already fresh
 * via the run query.
 *
 * Authorisation: the four REST reads are member-scoped on the server.
 * This view never reproduces the check; a non-member surfaces here as
 * 403/410 → state e. The component props type-clamp the data sources:
 * `PlanProposalCard` only accepts `ListedPlan[]`; `TeamConstraintsPanel`
 * only accepts `TripConstraintFact[]` from the `teamVisibleFacts` slice.
 * Neither can reach `constraintsOwner`, `researchIntentDraft`,
 * `pendingBriefProposal`, `tripBriefProposal`, or `chat_messages`.
 */
export function SharedPlanView({ tripId }: { tripId: string }) {
  const t = useTranslations("trips.sharedPlan");
  const feed = useSharedPlanFeed(tripId);
  const plansQuery = useTripPlans(tripId);
  const researchQuery = useLatestResearchResult(tripId);

  // Loading: any of the four reads still in flight. Treat the run as the
  // primary loading signal so we don't bounce between states.
  if (plansQuery.isLoading) {
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
  const allPlans = data
    ? [...data.proposed, ...data.active, ...data.stale]
    : [];
  const empty = allPlans.length === 0;

  // Phase 4 — acknowledge the pointer for the rail unread badge. We only
  // write when we are about to render plans (§7.2.c) so the empty state
  // doesn't accidentally clear a future "first plan" badge; the pointer
  // helper itself enforces the "never decreases" invariant.
  if (!empty) {
    const maxVersion = allPlans.reduce((acc, p) => Math.max(p.version, acc), 0);
    if (maxVersion > readLastSeenVersion(tripId)) {
      writeLastSeenVersion(tripId, maxVersion);
    }
  }

  // State a — empty. No manual-replan button (§6 forbidden); only a pointer
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

  // A PROPOSE_PLAN research run can complete safely without a plan when live
  // evidence is missing. It is not the same state as "no run yet"; make the
  // outcome and its repair path visible instead of hiding it behind an empty
  // Shared-plan panel.
  const latestResearch = researchQuery.data?.result ?? null;
  const matchingResearch = latestResearch?.agentTaskRunId === feed.run?.runId
    ? latestResearch
    : null;
  // Whether to explain is decided by the run alone; the research row only
  // supplies *which* capabilities were missing. Requiring the match here made
  // the panel depend on a second request that this component never waits for
  // — only `plansQuery.isLoading` gates the first paint — so a run that
  // completed with gaps fell through to the generic branch below and rendered
  // a status bar over an empty surface. The list degrades to a summary line
  // when the detail has not arrived (or the row is missing) rather than
  // taking the explanation away with it.
  //
  // 2026-09-06: a replan persisted `serviceGaps: []`, so the run terminal
  // status collapsed to `COMPLETED` and the Shared Plan view rendered
  // "方案已就绪" over an empty surface. The planless-terminal check must
  // fire for any terminal status whose `resultPlanId` is null, not just
  // `COMPLETED_WITH_GAPS`. Mirror the `hasPlan` predicate used by the run
  // detail view so both surfaces agree.
  const hasPlan = (feed.run?.resultPlanId ?? matchingResearch?.resultPlanId) != null;
  if (empty && feed.run?.status === "FAILED") {
    return (
      <section
        data-testid="shared-plan-failed"
        role="alert"
        className="grid gap-2 border-2 border-destructive bg-destructive/5 p-6 text-left wanderly-edge wanderly-r-md"
      >
        <p className="text-base font-bold text-destructive">{t("status.failed")}</p>
        {feed.run.errorCode ? <p className="text-sm text-muted-foreground">{feed.run.errorCode}</p> : null}
        <Link href={`/trips/${tripId}/runs/${feed.run.runId}`} className="w-fit text-sm font-bold text-sky-800 hover:underline">
          {t("gaps.detail")}
        </Link>
      </section>
    );
  }
  const terminalRun = feed.run != null
    && (feed.run.status === "COMPLETED"
      || feed.run.status === "COMPLETED_WITH_GAPS");
  const noPlanTerminal = terminalRun && !hasPlan;
  const explainPlanless = matchingResearch?.summaryReason === "PLAN_SCHEMA_UNMET";
  if (noPlanTerminal && feed.run) {
    return (
      <section
        data-testid="shared-plan-gaps"
        aria-label={explainPlanless ? t("gaps.planSchemaUnmetTitle") : t("gaps.title")}
        className="grid gap-3 border-2 border-amber-400 bg-amber-50 p-6 text-left wanderly-edge wanderly-r-md"
      >
        <p className="text-base font-bold text-amber-950">
          {explainPlanless ? t("gaps.planSchemaUnmetTitle") : t("gaps.title")}
        </p>
        <p className="text-sm text-amber-950">
          {explainPlanless ? t("gaps.planSchemaUnmetBody") : t("gaps.body")}
        </p>
        {matchingResearch ? (
          <ul className="grid gap-1 text-sm text-amber-950">
            {matchingResearch.serviceGaps.map((gap, index) => (
              <li key={`${gap.capability}-${gap.code}-${index}`}>{gap.capability}: {gap.code}</li>
            ))}
          </ul>
        ) : null}
        <Link href={`/trips/${tripId}/runs/${feed.run.runId}`} className="w-fit text-sm font-bold text-sky-800 hover:underline">
          {t("gaps.detail")}
        </Link>
      </section>
    );
  }

  // States b / c / d — assemble the status bar, version trail, constraint
  // panel, and the proposal cards. Cards are sorted with proposed first
  // (so the unread badge semantics line up) then active then stale.
  return (
    <div className="grid gap-3">
      <SharedPlanStatusBar run={feed.run} />
      {allPlans.length > 0 ? <PlanVersionTrail plans={allPlans} /> : null}
      <TeamConstraintsPanel facts={feed.constraints} />
      <ul className="grid gap-3">
        {data?.proposed.map((plan) => (
          <li key={plan.id}>
            <PlanProposalCard plan={plan} tripId={tripId} />
          </li>
        ))}
        {data?.active.map((plan) => (
          <li key={plan.id}>
            <PlanProposalCard plan={plan} tripId={tripId} />
          </li>
        ))}
        {data?.stale.map((plan) => (
          <li key={plan.id}>
            <PlanProposalCard plan={plan} tripId={tripId} />
          </li>
        ))}
      </ul>
    </div>
  );
}
