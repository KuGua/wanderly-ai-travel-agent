import type { ReactNode } from "react";

import { useConfirmResearchCommand } from "@/lib/query/hooks";
import type {
  PersonalResearchIntent,
  ResearchCommandRequest,
} from "@/lib/api/contracts";
import { useTravelApi } from "@/lib/query/provider";
import { Button } from "@/components/ui/button";
import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";

/**
 * Phase 6 / Personal Trip Orchestrator — confirmation card.
 *
 * Mirrors the `trip.brief_proposed` confirmation card (lines 504-513 of
 * `travel-agent-chat.tsx`): the LLM extracts a draft `personalResearchIntent`,
 * the model-facing card shows "确认运行" / "取消" buttons, and the user's
 * confirm fires `POST /trips/:tripId/research` with a fresh `requestId`.
 */
export function ResearchConfirmationCard({
  tripId,
  intent,
  onDismiss,
}: {
  tripId: string;
  intent: PersonalResearchIntent;
  onDismiss: () => void;
}): ReactNode {
  const api = useTravelApi();
  const mutation = useConfirmResearchCommand(tripId);

  function buildPayload(): ResearchCommandRequest | null {
    if (!api) return null;
    return {
      requestId: crypto.randomUUID(),
      outputMode: intent.kind,
      requestedCapabilities: intent.requestedCapabilities,
    };
  }

  return (
    <div
      data-testid="research-confirmation-card"
      className="rounded-md border border-border bg-card p-3 text-sm"
    >
      <p className="mb-2 font-medium">运行研究</p>
      <p className="mb-1 text-xs text-muted-foreground">
        模式：{intent.kind === "PROPOSE_PLAN" ? "研究 + 自动生成方案" : "仅研究"}
      </p>
      <p className="mb-3 text-xs text-muted-foreground">
        能力：{intent.requestedCapabilities.join(", ")}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={mutation.isPending || !api}
          onClick={() => {
            const payload = buildPayload();
            if (!payload) return;
            recordUiDiagnostic("research.command_confirm");
            mutation.mutate(payload, {
              onSuccess: () => onDismiss(),
            });
          }}
        >
          确认运行
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={() => {
            recordUiDiagnostic("research.command_reject");
            onDismiss();
          }}
        >
          取消
        </Button>
      </div>
      {mutation.isError ? (
        <p role="alert" className="mt-2 text-xs text-red-500">
          提交失败：{(mutation.error as Error).message}
        </p>
      ) : null}
    </div>
  );
}