"use client";

import { useTranslations } from "next-intl";

import type { TripConstraintFact } from "@/lib/api/contracts";

/**
 * Shared Plan Surface — Phase 3 team constraints panel.
 *
 * Renders the `teamVisibleFacts` slice returned by
 * `GET /trips/:tripId/constraints`. Per spec §7.2: only the field key,
 * source category, and revision are surfaced; values, member
 * attribution, and confidential visibility are deliberately omitted.
 *
 * The component accepts only `TripConstraintFact[]`; `constraintsOwner`
 * (the owner-only list with confidential values) cannot be wired in
 * because its type lives behind a separate schema. This is the
 * enforcement boundary — the view never sees the wrong list.
 */
export function TeamConstraintsPanel({ facts }: { facts: TripConstraintFact[] }) {
  const t = useTranslations("trips.sharedPlan.constraints");
  if (facts.length === 0) {
    return (
      <section aria-label={t("heading")} data-testid="team-constraints-empty" className="bg-card p-4 text-sm text-muted-foreground wanderly-edge wanderly-r-md">
        {t("empty")}
      </section>
    );
  }
  return (
    <section aria-label={t("heading")} data-testid="team-constraints-panel" className="grid gap-2 bg-card p-4 wanderly-edge wanderly-r-md wanderly-shadow">
      <h3 className="text-xs font-bold">{t("heading")}</h3>
      <ul className="grid gap-1">
        {facts.map((fact) => (
          <li key={fact.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
            <span className="font-mono">{fact.fieldKey}</span>
            <span className="ml-auto text-[10px] font-extrabold uppercase tracking-[0.08em] text-muted-foreground">
              {t(`strength.${fact.strength}`)}
            </span>
            <span className="text-[10px] text-muted-foreground">rev {fact.revision}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}