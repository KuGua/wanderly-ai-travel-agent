import type { ReactNode } from "react";

import type { ResearchStageEvent } from "@/lib/api/contracts";
import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";

const STAGE_LABEL: Record<ResearchStageEvent["stage"], string> = {
  SNAPSHOT_CREATED: "快照已建",
  RESEARCHING: "研究进行中",
  VALIDATING: "校验中",
  PERSISTING: "持久化中",
  COMPLETED: "已完成",
  COMPLETED_WITH_GAPS: "已完成（含缺失）",
  FAILED: "失败",
  STALE: "已过期",
};

/**
 * Phase 6 / Personal Trip Orchestrator — run card.
 *
 * Streams `research.stage` events for an accepted command. Mirrors
 * `ProposalAdoptionCard` in `team-orchestration/TeamOrchestrationPanel.tsx`
 * (removed in Phase 3 — the same data now drives
 * `plan-proposal-card.tsx` in `shared-plan/`).
 * with bounded labels only.
 */
export function ResearchRunCard({
  runId,
  stages,
  outcome,
  onView,
}: {
  runId: string;
  stages: ResearchStageEvent[];
  outcome: "COMPLETED" | "COMPLETED_WITH_GAPS" | "FAILED" | "STALE" | null;
  onView?: () => void;
}): ReactNode {
  recordUiDiagnostic("research.stage_view");
  return (
    <div
      data-testid="research-run-card"
      data-run-id={runId}
      className="rounded-md border border-border bg-card p-3 text-sm"
    >
      <p className="mb-2 font-medium">研究运行 #{runId.slice(0, 8)}</p>
      <ul className="mb-2 space-y-1 text-xs text-muted-foreground">
        {stages.length === 0 ? (
          <li>等待阶段…</li>
        ) : (
          stages.map((stage) => (
            <li key={`${stage.stage}-${stage.generationAttempt}`}>
              {STAGE_LABEL[stage.stage] ?? stage.stage}
            </li>
          ))
        )}
      </ul>
      {outcome ? <p className="text-xs font-medium">结果：{STAGE_LABEL[outcome]}</p> : null}
      {onView ? (
        <button
          type="button"
          className="mt-2 text-xs text-primary underline"
          onClick={onView}
        >
          查看最新结果
        </button>
      ) : null}
    </div>
  );
}