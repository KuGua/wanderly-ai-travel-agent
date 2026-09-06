"use client";

import { useTranslations } from "next-intl";

import type { AgentRun } from "@/lib/api/contracts";

/**
 * Shared Plan Surface — run lifecycle strip (Phase 2).
 *
 * Renders the textual status of the latest PLAN/REPLAN run for the trip.
 * `useTranslations` namespaces live under `trips.sharedPlan.status.*`;
 * unknown statuses deliberately fall through to a generic "running" line
 * so a server-side enum addition does not break the UI silently.
 *
 * Phase 2 uses the snapshot the view already has (`useSharedPlanFeed.run`)
 * to keep the status line honest without an extra request. Phase 4 hooks
 * an SSE connection that updates the same `AgentRun` shape, so no
 * change is needed here when SSE lands.
 *
 * `errorCode` mapping (§11.3) is deliberately deferred to the dedicated
 * failed-state copy in the parent view, not in this strip; the strip's
 * job is to label lifecycle, not to explain the failure.
 */
export function SharedPlanStatusBar({ run }: { run: AgentRun | null }) {
  const t = useTranslations("trips.sharedPlan.status");
  if (!run) return null;

  const statusKey = statusToTranslationKey(run);
  // Format updatedAt as a relative-time / locale string best-effort. The
  // value is a server-generated ISO timestamp; Intl.DateTimeFormat will
  // throw on malformed input, so guard with try/catch.
  const updatedLabel = (() => {
      try {
        return new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          month: "short",
          day: "numeric",
        }).format(new Date(run.updatedAt));
      } catch {
        return run.updatedAt;
      }
    })();

  return (
    <section
      data-testid="shared-plan-status-bar"
      data-status={run.status}
      aria-live="polite"
      className="flex flex-col gap-1 border-2 border-[var(--w-ink)] bg-[var(--w-fog)] px-3 py-2 wanderly-edge wanderly-r-md"
    >
      <p className="text-xs font-extrabold text-[var(--w-ink)]">{t(statusKey)}</p>
      <p className="text-[11px] text-[var(--w-ink)] opacity-70">
        {t("lastUpdated", { value: updatedLabel })}
      </p>
    </section>
  );
}

function statusToTranslationKey(run: AgentRun): string {
  switch (run.status) {
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "researching";
    case "COMPLETED":
      return "completed";
    // Gaps describe provider coverage, not whether persistence produced a
    // plan. Keep the planless explanation for a null result pointer and use
    // an honest success-with-gaps label when a plan was saved.
    case "COMPLETED_WITH_GAPS":
      return run.resultPlanId ? "completedWithGapsPlan" : "completedWithGaps";
    case "FAILED":
    case "STALE":
      return "failed";
    case "CANCELLED":
    case "CANCEL_REQUESTED":
      return "cancelled";
    // RETRYING / PERSISTING are derived from stream phases, not surfaced
    // on the AgentRun DTO today. If they ever land, the keys already
    // exist; we just defer to "researching" for now.
    default:
      return "researching";
  }
}
