"use client";

import { useEffect, useState, type ReactNode } from "react";

import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";
import type { ResearchCapability } from "@/lib/trips/personal-research-readiness-copy";

/**
 * Generic "acknowledge-before-continuing" confirmation dialog.
 *
 * Mirrors the inline `ConfirmationModal` pattern from
 * `TeamOrchestrationPanel.tsx` — fixed-position overlay, amber warning
 * text, mandatory acknowledgement checkbox that gates the confirm button.
 * Lifted into a shared primitive so Phase 2 of Personal Research can reuse
 * it for the real-provider warning before triggering flight / hotel /
 * accommodation / places / mobility / navigation research, and
 * `TeamOrchestrationPanel` can migrate to it in a follow-up.
 *
 * Diagnostic events fire on both confirm (`acknowledged`) and cancel
 * (`declined`) so the policy's effect can be measured via the existing
 * OTel layer. The `capabilities` array is forwarded as the `capabilities`
 * attribute so dashboards can filter by surface.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: string;
  acknowledgeLabel: string;
  confirmLabel: string;
  cancelLabel: string;
  capabilities: ResearchCapability[];
  diagnosticTag: "research.real_provider_acknowledged" | "research.real_provider_declined";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps): ReactNode | null {
  const [acknowledged, setAcknowledged] = useState(false);

  // Reset acknowledgement when the dialog closes so a fresh open requires
  // a fresh tick. (We deliberately do NOT persist across opens — the
  // sessionStorage layer above the dialog decides whether to open at all.)
  useEffect(() => {
    if (!props.open) setAcknowledged(false);
  }, [props.open]);

  if (!props.open) return null;

  function handleConfirm(): void {
    recordUiDiagnostic(props.diagnosticTag, {
      capabilities: props.capabilities,
    });
    props.onConfirm();
  }

  function handleCancel(): void {
    recordUiDiagnostic(props.diagnosticTag, {
      capabilities: props.capabilities,
    });
    props.onCancel();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="confirm-dialog"
    >
      <div className="max-w-md rounded-md bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold">{props.title}</h2>
        <p className="mt-3 text-sm text-amber-700">{props.body}</p>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            data-testid="confirm-dialog-ack"
          />
          {props.acknowledgeLabel}
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded bg-emerald-500 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            disabled={!acknowledged}
            onClick={handleConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {props.confirmLabel}
          </button>
          <button
            type="button"
            className="rounded bg-muted px-3 py-1 text-sm font-medium"
            onClick={handleCancel}
            data-testid="confirm-dialog-cancel"
          >
            {props.cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}