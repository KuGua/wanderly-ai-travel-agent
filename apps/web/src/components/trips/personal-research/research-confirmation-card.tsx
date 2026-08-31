import type { ReactNode } from "react";

import { useConfirmResearchCommand, useDismissResearchIntent } from "@/lib/query/hooks";
import type {
  PersonalResearchIntent,
  ResearchCommandRequest,
} from "@/lib/api/contracts";
import { useTravelApi, useOptionalTravelApi } from "@/lib/query/provider";
import { Button } from "@/components/ui/button";
import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";
import {
  type PersonalResearchMissingCode,
  type PersonalResearchReadiness,
  renderMissingCodes,
  renderReadinessHeadline,
} from "@/lib/trips/personal-research-readiness-copy";

/**
 * Personal Research Intent — owner confirmation card (Phase 2).
 *
 * Two variants share one card surface and one `data-testid`:
 *
 *  1. `model-extracted` — the legacy LLM-extracted draft, used when the
 *     research.intent_extracted SSE arrives before Phase 1 ships. No
 *     readiness data is available; the card always enables confirm.
 *
 *  2. `classifier-extracted` — the Phase 1 server-classified draft.
 *     Carries `readiness` + `missing[]` so the card can disable confirm
 *     when setup or place selection is required. Dismissal goes through
 *     the new `POST /agent-runs/:runId/dismiss-intent` route.
 *
 * Both paths share the same `data-testid="research-confirmation-card"`
 * so existing tests stay green; the diagnostic actions are split
 * (`research.command_confirm` / `research.intent_dismiss`) so the
 * dismissal route is observable in metrics independent of confirm.
 */
export type ResearchConfirmationCardProps = {
  tripId: string;
  onDismiss: () => void;
} & (
  | {
      source: "model-extracted";
      intent: PersonalResearchIntent;
    }
  | {
      source: "classifier-extracted";
      runId: string;
      intent: PersonalResearchIntent;
      readiness: PersonalResearchReadiness;
      missing: PersonalResearchMissingCode[];
    }
);

export function ResearchConfirmationCard(props: ResearchConfirmationCardProps): ReactNode {
  const { tripId, onDismiss } = props;
  const api = useOptionalTravelApi();
  const confirmMutation = useConfirmResearchCommand(tripId);
  const dismissMutation = useDismissResearchIntent(
    props.source === "classifier-extracted" ? props.runId : null,
  );

  // Derive the headline / body for classifier-extracted variants. The
  // model-extracted path uses the legacy "ready to run" copy because
  // readiness is unknown.
  const headline = props.source === "classifier-extracted"
    ? renderReadinessHeadline(props.readiness)
    : { headline: "准备运行研究", body: "已就绪，点击确认开始。" };
  const isReady = props.source === "classifier-extracted"
    ? props.readiness === "READY"
    : true;

  function buildPayload(): ResearchCommandRequest | null {
    if (!api) return null;
    return {
      requestId: crypto.randomUUID(),
      outputMode: props.intent.kind,
      requestedCapabilities: props.intent.requestedCapabilities,
      ...(props.source === "classifier-extracted"
        ? { originatingIntentRunId: props.runId }
        : {}),
    };
  }

  return (
    <div
      data-testid="research-confirmation-card"
      data-source={props.source}
      data-readiness={props.source === "classifier-extracted" ? props.readiness : undefined}
      className="rounded-md border border-border bg-card p-3 text-sm"
    >
      <p className="mb-2 font-medium">{headline.headline}</p>
      <p className="mb-1 text-xs text-muted-foreground">{headline.body}</p>
      <p className="mb-1 text-xs text-muted-foreground">
        模式：{props.intent.kind === "PROPOSE_PLAN" ? "研究 + 自动生成方案" : "仅研究"}
      </p>
      <p className="mb-1 text-xs text-muted-foreground">
        能力：{props.intent.requestedCapabilities.join(", ")}
      </p>
      {props.source === "classifier-extracted" && props.missing.length > 0 ? (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2">
          <p className="mb-1 text-xs font-medium text-amber-900">发起前需要补全：</p>
          <ul className="list-disc pl-4 text-xs text-amber-900">
            {renderMissingCodes(props.missing).map((title, idx) => (
              <li key={idx}>{title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!isReady || confirmMutation.isPending || dismissMutation.isPending || !api}
          onClick={() => {
            const payload = buildPayload();
            if (!payload) return;
            recordUiDiagnostic("research.command_confirm");
            confirmMutation.mutate(payload, {
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
          disabled={confirmMutation.isPending || dismissMutation.isPending}
          onClick={() => {
            if (props.source === "classifier-extracted") {
              dismissMutation.mutate(undefined, {
                onSuccess: () => onDismiss(),
              });
            } else {
              recordUiDiagnostic("research.command_reject");
              onDismiss();
            }
          }}
        >
          取消
        </Button>
      </div>
      {confirmMutation.isError ? (
        <p role="alert" className="mt-2 text-xs text-red-500">
          提交失败：{(confirmMutation.error as Error).message}
        </p>
      ) : null}
      {dismissMutation.isError ? (
        <p role="alert" className="mt-2 text-xs text-red-500">
          取消失败：{(dismissMutation.error as Error).message}
        </p>
      ) : null}
    </div>
  );
}
