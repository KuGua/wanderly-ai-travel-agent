import type { ReactNode } from "react";

import type { ListedPlan } from "@/lib/api/contracts";
import { useSoloAdoptPlan } from "@/lib/query/hooks";
import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";
import { Button } from "@/components/ui/button";
import { useErrorMessage } from "@/lib/api/use-error-message";

/**
 * Phase 6 / Personal Trip Orchestrator — solo plan proposal card.
 *
 * Mirrors `ProposalAdoptionCard` in `team-orchestration/TeamOrchestrationPanel.tsx`
 * (removed in Phase 3 — the same data now drives
 * `plan-proposal-card.tsx` in `shared-plan/`).
 * but with a single ACCEPT button. The team path uses
 * `castAdoptionVote(decision: "ACCEPT")`; this path uses
 * `acceptSoloPlan` which writes the owner's `member_confirmations` row in
 * the same transaction as the activation.
 */
export function SoloPlanProposalCard({
  tripId,
  plan,
  onAdopted,
}: {
  tripId: string;
  plan: Pick<ListedPlan, "id" | "version" | "status" | "destination">;
  onAdopted?: () => void;
}): ReactNode {
  const mutation = useSoloAdoptPlan(tripId);
  const errorMessage = useErrorMessage();
  return (
    <div
      data-testid="solo-plan-proposal-card"
      data-plan-id={plan.id}
      className="rounded-md border border-border bg-card p-3 text-sm"
    >
      <p className="mb-2 font-medium">Solo 方案 v{plan.version} · {plan.destination}</p>
      <p className="mb-3 text-xs text-muted-foreground">
        状态：{plan.status}
      </p>
      <Button
        type="button"
        size="sm"
        disabled={mutation.isPending || plan.status !== "PROPOSED"}
        onClick={() => {
          recordUiDiagnostic("research.command_confirm");
          mutation.mutate(plan.id, { onSuccess: () => onAdopted?.() });
        }}
      >
        采纳此方案
      </Button>
      {mutation.isError ? (
        <p role="alert" className="mt-2 text-xs text-red-500">
          采纳失败：{errorMessage(mutation.error)}
        </p>
      ) : null}
    </div>
  );
}
