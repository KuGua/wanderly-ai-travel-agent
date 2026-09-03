import { useState, type ReactNode } from "react";
import { viewerScopedKey } from "@/lib/auth/viewer-scoped-storage";

import { useConfirmResearchCommand, useDismissResearchIntent } from "@/lib/query/hooks";
import type {
  PersonalResearchIntent,
  ResearchCommandRequest,
} from "@/lib/api/contracts";
import { useTravelApi, useOptionalTravelApi } from "@/lib/query/provider";
import { Button } from "@/components/ui/button";
import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";
import {
  MISSING_COPY,
  type PersonalResearchMissingCode,
  type PersonalResearchReadiness,
  renderReadinessHeadline,
} from "@/lib/trips/personal-research-readiness-copy";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { realProviderCapabilities, type ResearchCapability } from "@/lib/trips/personal-research-readiness-copy";

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
 *     Carries `readiness` + `blockers[]` + `warnings[]` so the card can
 *     disable confirm when hard blockers are present, while still allowing
 *     the owner to proceed past soft warnings. Dismissal goes through
 *     `POST /agent-runs/:runId/dismiss-intent`.
 *
 * Both paths share `data-testid="research-confirmation-card"`. Diagnostic
 * actions are split (`research.command_confirm` / `research.intent_dismiss`).
 *
 * When the requested capabilities include any real-provider capability
 * (flight, hotel, accommodation, places, mobility, navigation), the
 * confirm button opens a `ConfirmDialog` first — the user must explicitly
 * acknowledge the live-provider call before `useConfirmResearchCommand`
 * fires. Acknowledgement is remembered in `sessionStorage` per capability
 * set so the modal is not repeated within the same session.
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
      blockers: PersonalResearchMissingCode[];
      warnings: PersonalResearchMissingCode[];
      /** Optional legacy field — derived from blockers ∪ warnings if absent. */
      missing?: PersonalResearchMissingCode[];
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

  // Defensive normalize: if the server sent only the legacy `missing[]`
  // (no separate blockers/warnings), partition on severity.
  const blockers = props.source === "classifier-extracted"
    ? (props.blockers ?? partitionLegacyMissing(props.missing ?? []).blockers)
    : [];
  const warnings = props.source === "classifier-extracted"
    ? (props.warnings ?? partitionLegacyMissing(props.missing ?? []).warnings)
    : [];
  const hasBlockers = blockers.length > 0;
  const canConfirm = props.source === "model-extracted" || !hasBlockers;

  // Real-provider confirmation modal state. Only used when the request
  // includes at least one capability that hits a paid/limited provider.
  const realProviders = realProviderCapabilities(
    props.intent.requestedCapabilities as ResearchCapability[],
  );
  const needsRealProviderAck = realProviders.length > 0;
  // Scoped to the viewer: this is an acknowledgement that the next search
  // reaches real suppliers, and one traveller must not be able to give it on
  // another's behalf by having used the same browser first.
  const realProviderKey = needsRealProviderAck
    ? viewerScopedKey(`research.realProviderAcked.${[...realProviders].sort().join("|")}`)
    : "";
  const [realProviderModalOpen, setRealProviderModalOpen] = useState(false);

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

  function isAcked(): boolean {
    if (!needsRealProviderAck) return true;
    try {
      return sessionStorage.getItem(realProviderKey) === "1";
    } catch {
      return false;
    }
  }

  function markAcked(): void {
    if (!needsRealProviderAck) return;
    try {
      sessionStorage.setItem(realProviderKey, "1");
    } catch {
      /* sessionStorage unavailable (private mode, etc.) — fall through and re-prompt next time. */
    }
  }

  function fireConfirm(): void {
    const payload = buildPayload();
    if (!payload) return;
    recordUiDiagnostic("research.command_confirm", {
      capabilities: props.intent.requestedCapabilities,
    });
    confirmMutation.mutate(payload, {
      onSuccess: () => onDismiss(),
    });
  }

  function handleConfirmClick(): void {
    if (!canConfirm) return;
    if (needsRealProviderAck && !isAcked()) {
      setRealProviderModalOpen(true);
      return;
    }
    fireConfirm();
  }

  function handleModalConfirm(): void {
    markAcked();
    setRealProviderModalOpen(false);
    fireConfirm();
  }

  function handleModalCancel(): void {
    recordUiDiagnostic("research.real_provider_declined", {
      capabilities: realProviders,
    });
    setRealProviderModalOpen(false);
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
      {hasBlockers ? (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2" data-testid="blockers-region">
          <p className="mb-1 text-xs font-medium text-amber-900">发起前需要补全：</p>
          <ul className="list-disc pl-4 text-xs text-amber-900">
            {blockers.map((code) => {
              const copy = MISSING_COPY[code];
              return (
                <li key={code}>
                  <span className="font-medium">{copy.title}</span>
                  <span className="ml-1 text-amber-800">— {copy.detail}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="mb-3 rounded-md border border-border bg-muted/40 p-2" data-testid="warnings-region">
          <p className="mb-1 text-xs font-medium text-muted-foreground">提示（可继续）：</p>
          <ul className="list-disc pl-4 text-xs text-muted-foreground">
            {warnings.map((code) => {
              const copy = MISSING_COPY[code];
              return (
                <li key={code}>
                  <span>{copy.title}</span>
                  <span className="ml-1 text-muted-foreground/80">— {copy.detail}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!canConfirm || confirmMutation.isPending || dismissMutation.isPending || !api}
          onClick={handleConfirmClick}
          data-testid="research-confirm-run"
        >
          {hasBlockers ? "补全资料后继续" : warnings.length > 0 ? "继续运行" : "确认运行"}
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
      <ConfirmDialog
        open={realProviderModalOpen}
        title="本次研究将调用真实供应商"
        body={`你请求的研究会向 ${realProviders.join("、")} 发送实时查询，可能产生费用或占用配额。结果与最终行程可能不完全匹配。`}
        acknowledgeLabel="我已知晓，仍要继续"
        confirmLabel="继续运行"
        cancelLabel="取消"
        capabilities={realProviders as ResearchCapability[]}
        diagnosticTag="research.real_provider_acknowledged"
        onConfirm={handleModalConfirm}
        onCancel={handleModalCancel}
      />
    </div>
  );
}

/** Partition a legacy `missing[]` into blockers / warnings using severity tags. */
function partitionLegacyMissing(codes: PersonalResearchMissingCode[]): {
  blockers: PersonalResearchMissingCode[];
  warnings: PersonalResearchMissingCode[];
} {
  const blockers: PersonalResearchMissingCode[] = [];
  const warnings: PersonalResearchMissingCode[] = [];
  for (const code of codes) {
    if (MISSING_COPY[code].severity === "blocker") blockers.push(code);
    else warnings.push(code);
  }
  return { blockers, warnings };
}