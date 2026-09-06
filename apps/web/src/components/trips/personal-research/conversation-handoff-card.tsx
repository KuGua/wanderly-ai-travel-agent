import { useState } from "react";
import { useTranslations } from "next-intl";

import type {
  ConstraintHandoffBatchResponse,
  ConstraintHandoffConfirmResponse,
  ConstraintStrength,
  ConstraintVisibility,
} from "@/lib/api/contracts";
import {
  useConfirmConstraintHandoffBatch,
} from "@/lib/query/hooks";
import { recordUiDiagnostic } from "@/lib/observability/ui-diagnostics";
import { useErrorMessage } from "@/lib/api/use-error-message";

/**
 * Phase 6 / Member conversation handoff — candidate card.
 *
 * Member-private surface for one PENDING candidate batch extracted from a
 * private-thread turn. The card:
 *   - Lists each proposal with its normalized field + value (rendered as JSON);
 *   - Lets the member toggle visibility / strength per row, restricted to the
 *     catalog allow-list (the server's `parseConstraintField` is still the
 *     authority; the UI is a friendly shortcut);
 *   - Shows residual-inference warnings the catalog requires for fields with
 *     `residualInferenceWarningToken` (e.g. budget / pace / accessibility);
 *   - Submits the trimmed `proposalId + visibility + strength` payload to
 *     `/constraint-handoffs/:batchId/confirm` with an idempotency key
 *     (`requestId = crypto.randomUUID()`), so a duplicate click does not
 *     create a second fact / snapshot / plan.
 *
 * The card never shows: the raw model rationale, other members' batches,
 * snapshot / plan / provider authority, or anything from the chat transcript.
 *
 * i18n: keys live under `trips.workspace.handoff*`; the loading and error
 * states inherit the host's namespace (`trips.workspace`).
 */
export function ConversationHandoffCard({
  tripId,
  batch,
  onConfirmed,
  onDismissed,
}: {
  tripId: string;
  batch: ConstraintHandoffBatchResponse;
  /**
   * Fired with the server response (`{ runId, snapshotId, operation,
   * status }`) once the confirm mutation succeeds. Phase 2 surfaces
   * this to the workspace so it can auto-switch the triggering member
   * to the shared view when the run reaches a terminal status.
   */
  onConfirmed?: (result: ConstraintHandoffConfirmResponse) => void;
  onDismissed?: () => void;
}) {
  // The handoff strings live under `teamOrchestration`, not `trips.workspace` —
  // that namespace has no `handoff*` key at all, so every label in this card
  // was rendering as its own key path.
  const t = useTranslations("teamOrchestration");
  const errorMessage = useErrorMessage();
  const [selections, setSelections] = useState<Map<string, { visibility: ConstraintVisibility; strength: ConstraintStrength }>>(() => {
    const initial = new Map<string, { visibility: ConstraintVisibility; strength: ConstraintStrength }>();
    for (const proposal of batch.batch) {
      if (proposal.status === "PENDING") {
        initial.set(proposal.id, {
          visibility: proposal.proposedVisibility,
          strength: proposal.strength,
        });
      }
    }
    return initial;
  });

  const mutation = useConfirmConstraintHandoffBatch(tripId, batch.batchId);

  const pending = batch.batch.filter((p) => p.status === "PENDING");
  const confirmed = batch.batch.filter((p) => p.status === "CONFIRMED");
  const allResolved = pending.length === 0;

  const updateSelection = (
    proposalId: string,
    patch: Partial<{ visibility: ConstraintVisibility; strength: ConstraintStrength }>,
  ) => {
    setSelections((current) => {
      const next = new Map(current);
      const existing = next.get(proposalId);
      if (!existing) return current;
      next.set(proposalId, { ...existing, ...patch });
      return next;
    });
  };

  const toggleSelection = (proposal: (typeof batch.batch)[number]) => {
    setSelections((current) => {
      const next = new Map(current);
      if (next.has(proposal.id)) {
        next.delete(proposal.id);
      } else {
        next.set(proposal.id, {
          visibility: proposal.proposedVisibility,
          strength: proposal.strength,
        });
      }
      return next;
    });
  };

  const submit = () => {
    if (selections.size === 0) return;
    const payload = {
      requestId: crypto.randomUUID(),
      candidateVersion: batch.candidateVersion,
      selections: Array.from(selections.entries()).map(([proposalId, choice]) => ({
        proposalId,
        visibility: choice.visibility,
        strength: choice.strength,
      })),
    };
    recordUiDiagnostic("conversation.handoff_confirm");
    mutation.mutate(payload, { onSuccess: (result) => onConfirmed?.(result) });
  };

  return (
    <section
      data-testid="conversation-handoff-card"
      data-batch-id={batch.batchId}
      aria-label="Member conversation candidate handoff"
      className="rounded-[18px] border border-primary/20 bg-white p-3 text-sm shadow-sm"
    >
      <p className="font-bold text-primary">{t("handoffHeading")} · {pending.length}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("handoffBody")}
      </p>

      {batch.residualInferenceWarnings.length > 0 ? (
        <p
          role="note"
          data-testid="residual-inference-warning"
          className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
        >
          {batch.residualInferenceWarnings.join(", ")}
        </p>
      ) : null}

      <ul className="mt-3 grid gap-2">
        {pending.map((proposal) => {
          const choice = selections.get(proposal.id);
          return (
            <li
              key={proposal.id}
              data-testid="handoff-candidate-row"
              data-proposal-id={proposal.id}
              data-field-key={proposal.fieldKey}
              className="rounded-md border border-border bg-card/60 p-2"
            >
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1 text-xs font-medium">
                  <input
                    type="checkbox"
                    data-testid="handoff-select-checkbox"
                    checked={Boolean(choice)}
                    onChange={() => toggleSelection(proposal)}
                  />
                  {t("handoffSelect")}
                </label>
                <span className="font-mono text-xs text-muted-foreground">{proposal.fieldKey}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{proposal.status}</span>
              </div>
              <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted/40 p-2 text-xs">
                {JSON.stringify(proposal.valueJson, null, 2)}
              </pre>
              {choice ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1">
                  {t("handoffVisibility")}:
                  <select
                    data-testid="handoff-visibility-select"
                    value={choice.visibility}
                    onChange={(event) => updateSelection(proposal.id, { visibility: event.target.value as ConstraintVisibility })}
                    className="rounded border border-border bg-white px-1 py-0.5 text-xs"
                  >
                    <option value="TEAM_VISIBLE">TEAM_VISIBLE</option>
                    <option value="ORCHESTRATOR_CONFIDENTIAL">ORCHESTRATOR_CONFIDENTIAL</option>
                  </select>
                </label>
                <label className="flex items-center gap-1">
                  {t("handoffStrength")}:
                  <select
                    data-testid="handoff-strength-select"
                    value={choice.strength}
                    onChange={(event) => updateSelection(proposal.id, { strength: event.target.value as ConstraintStrength })}
                    className="rounded border border-border bg-white px-1 py-0.5 text-xs"
                  >
                    <option value="HARD">HARD</option>
                    <option value="SOFT">SOFT</option>
                  </select>
                </label>
              </div> : null}
            </li>
          );
        })}
      </ul>

      {confirmed.length > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("handoffAllConfirmed", { count: confirmed.length })}
          {pending.length > 0 ? ` ${t("handoffPending", { pending: pending.length })}` : ""}
        </p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          data-testid="handoff-confirm-button"
          onClick={submit}
          disabled={mutation.isPending || allResolved || selections.size === 0}
          className="min-h-11 rounded-full bg-primary px-3 text-xs font-bold text-white disabled:opacity-50"
        >
          {mutation.isPending ? t("handoffConfirming") : t("handoffConfirm")}
        </button>
        <button
          type="button"
          data-testid="handoff-dismiss-button"
          onClick={() => onDismissed?.()}
          className="min-h-11 rounded-full border border-primary/20 px-3 text-xs font-bold text-primary"
        >
          {t("handoffDismiss")}
        </button>
      </div>

      {mutation.isError ? (
        <p role="alert" className="mt-2 text-xs text-red-500">
          {t("handoffConfirmError", { message: errorMessage(mutation.error) })}
        </p>
      ) : null}
    </section>
  );
}
