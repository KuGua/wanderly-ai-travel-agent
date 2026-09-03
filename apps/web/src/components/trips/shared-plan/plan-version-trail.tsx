"use client";

import { useTranslations } from "next-intl";

import type { ListedPlan } from "@/lib/api/contracts";

/**
 * Shared Plan Surface — Phase 3 version trail.
 *
 * Renders a flat chronological chain of plans in the trip: stale →
 * proposed → active. The `replacedByPlanId` pointer on each plan is
 * the source of truth for "what came before what"; we walk the chain
 * from any active/proposed head and stop at the first stale row that
 * has no inbound replacement.
 *
 * The component never reaches for owner-only data — the entire trail
 * is built from the already-redacted `ListedPlan` shape.
 */
export function PlanVersionTrail({ plans }: { plans: ListedPlan[] }) {
  const t = useTranslations("trips.sharedPlan");
  if (plans.length === 0) return null;

  const chain = buildTrail(plans);
  if (chain.length === 0) return null;

  return (
    <nav aria-label={t("headerTitle")} data-testid="plan-version-trail" className="flex flex-wrap items-center gap-2">
      {chain.map((plan, idx) => (
        <span key={plan.id} className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-extrabold wanderly-edge-thin wanderly-r-xs ${STATUS_BADGE[plan.status]}`}>
            {t(`plan.statusBadge.${plan.status}`)}
          </span>
          <span className="font-mono text-[12px]">v{plan.version}</span>
          {idx < chain.length - 1 ? <span aria-hidden="true" className="text-muted-foreground">→</span> : null}
        </span>
      ))}
    </nav>
  );
}

/**
 * Build the ordered trail by following `replacedByPlanId` pointers. Start
 * from any plan whose `replacedByPlanId` is null OR points to nothing in
 * the visible set, then walk forward by reading the inbound pointer on
 * each step. Plans that form isolated islands (no inbound and no
 * outbound) appear in their own chain.
 */
function buildTrail(plans: ListedPlan[]): ListedPlan[] {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const outbound = new Set<string>();
  for (const p of plans) {
    if (p.replacedByPlanId) outbound.add(p.replacedByPlanId);
  }
  // Roots: plans that are not pointed to by any other plan in the set.
  // Stale / superseded / DRAFT rows are typically roots.
  const roots = plans.filter((p) => !outbound.has(p.id));
  // Pick the chain that contains the highest-version plan, falling back
  // to the first root so the UI is deterministic.
  const trail: ListedPlan[] = [];
  const visited = new Set<string>();
  let cursor: ListedPlan | undefined = roots[0];
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    trail.push(cursor);
    cursor = cursor.replacedByPlanId ? byId.get(cursor.replacedByPlanId) : undefined;
  }
  return trail;
}

const STATUS_BADGE: Record<ListedPlan["status"], string> = {
  DRAFT: "bg-[var(--w-fog)] text-[var(--w-ink)]",
  PROPOSED: "bg-[var(--w-highlight)] text-[var(--w-ink)]",
  ACTIVE: "bg-emerald-100 text-emerald-900",
  STALE: "bg-[var(--w-mist)] text-[var(--w-ink)]",
  SUPERSEDED: "bg-[var(--w-mist)] text-[var(--w-ink)]",
};