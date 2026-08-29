"use client";

import { CheckCircle2, ShieldAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import {
  useCastAdoptionVote,
  useConfirmConstraintProposal,
  useDismissConstraintProposal,
  usePlanAdoptionVotes,
  useTripConstraintsForMembers,
  useTripConstraintsForOwner,
  useTripPlans,
} from "@/lib/query/hooks";

type TeamOrchestrationPanelProps = {
  tripId: string;
};

/**
 * Team Agent 协作编排 — Trip 右栏面板。
 *
 * 不持有任何 sensitive 字段、不写入 Zustand/localStorage。所有 READ 路径走
 * `useTripConstraintsForMembers`（机密过滤，服务端 redactor）；所有 WRITE
 * 路径走 mutation hooks，自动 invalidate 同一 owner/members/plans 缓存键。
 *
 * 残余推断风险披露：`needsConfirm` 的事实 confirmation 弹窗永远展示
 * `trips.residualInferenceWarning` 文案；用户必须勾选才能 confirm（spec §1.4
 * 与 user confirmed decision）。
 */
export function TeamOrchestrationPanel({ tripId }: TeamOrchestrationPanelProps) {
  const t = useTranslations("teamOrchestration");

  const ownerFacts = useTripConstraintsForOwner(tripId);
  const memberFacts = useTripConstraintsForMembers(tripId);
  const plans = useTripPlans(tripId);
  const confirmMutation = useConfirmConstraintProposal(tripId);
  const dismissMutation = useDismissConstraintProposal(tripId);
  void dismissMutation;
  const castVoteMutation = useCastAdoptionVote(tripId);

  const [pendingProposalAck, setPendingProposalAck] = useState<{ proposalId: string; needsAck: boolean } | null>(null);

  const proposedPlans = plans.data?.proposed ?? [];
  const activePlans = plans.data?.active ?? [];
  const stalePlans = plans.data?.stale ?? [];
  const leadingProposal = proposedPlans[0];

  const ownerHasConfidential = useMemo(
    () => (ownerFacts.data?.allFacts ?? []).some(f => f.visibility === "ORCHESTRATOR_CONFIDENTIAL"),
    [ownerFacts.data],
  );

  return (
    <div className="flex flex-col gap-6 p-4">
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
      </header>

      <section aria-label={t("ownerPanel")} className="rounded-md border p-3">
        <h3 className="text-sm font-medium">{t("ownerPanel")}</h3>
        {ownerFacts.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("constraintsLoading")}</p>
        ) : (ownerFacts.data?.allFacts ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noConstraints")}</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {(ownerFacts.data?.allFacts ?? []).map(fact => (
              <li key={fact.id} className="flex items-center justify-between gap-2 rounded border bg-card px-2 py-1">
                <span className="font-mono text-xs">{fact.fieldKey}</span>
                <span className="text-xs text-muted-foreground">
                  {fact.visibility === "ORCHESTRATOR_CONFIDENTIAL" ? "private" : "team"} · rev {fact.revision}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t("memberPanel")} className="rounded-md border p-3">
        <h3 className="text-sm font-medium">{t("memberPanel")}</h3>
        {memberFacts.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("constraintsLoading")}</p>
        ) : (memberFacts.data?.teamVisibleFacts ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noConstraints")}</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {(memberFacts.data?.teamVisibleFacts ?? []).map(fact => (
              <li key={fact.id} className="flex items-center justify-between gap-2 rounded border bg-card px-2 py-1">
                <span className="font-mono text-xs">{fact.fieldKey}</span>
                <span className="text-xs text-muted-foreground">team · rev {fact.revision}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {ownerHasConfidential ? (
        <div className="flex items-start gap-2 rounded-md border-l-4 border-amber-500 bg-amber-50 p-3 text-amber-900">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p className="text-sm">{t("residualInferenceWarning")}</p>
        </div>
      ) : null}

      <section aria-label={t("plansProposedHeading")} className="rounded-md border p-3">
        <h3 className="text-sm font-medium">{t("plansProposedHeading")}</h3>
        {plans.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("plansLoading")}</p>
        ) : proposedPlans.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noProposal")}</p>
        ) : (
          <div className="mt-2 space-y-3 text-sm">
            {proposedPlans.map((plan) => (
              <ProposalAdoptionCard
                key={plan.id}
                tripId={tripId}
                planId={plan.id}
                onCast={(decision) =>
                  castVoteMutation.mutate({ planId: plan.id, input: { decision } })
                }
                outcome={castVoteMutation.data && castVoteMutation.variables?.planId === plan.id
                  ? castVoteMutation.data
                  : null}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-label={t("plansActiveHeading")} className="rounded-md border p-3">
        <h3 className="text-sm font-medium">{t("plansActiveHeading")}</h3>
        {activePlans.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {activePlans.map(plan => (
              <li key={plan.id} className="flex items-center justify-between rounded border bg-card px-2 py-1">
                <span className="font-mono text-xs">v{plan.version} · {plan.destination}</span>
                <span className="text-xs text-muted-foreground">active</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t("plansStaleHeading")} className="rounded-md border p-3">
        <h3 className="text-sm font-medium">{t("plansStaleHeading")}</h3>
        {stalePlans.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
            {stalePlans.map(plan => (
              <li key={plan.id} className="flex items-center justify-between rounded border px-2 py-1">
                <span className="font-mono text-xs">v{plan.version} · {plan.destination}</span>
                <span className="text-xs">{plan.staleReason ?? "stale"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {leadingProposal ? (
        <ConfirmationModal
          open={!!pendingProposalAck}
          proposal={leadingProposal}
          onCancel={() => setPendingProposalAck(null)}
          onAcknowledge={() => {
            if (!pendingProposalAck) return;
            const { proposalId, needsAck } = pendingProposalAck;
            setPendingProposalAck(null);
            if (needsAck) {
              confirmMutation.mutate(
                { proposalId, input: { visibility: "ORCHESTRATOR_CONFIDENTIAL", strength: "HARD" } },
              );
            }
          }}
          onConfirm={(visibility, strength) => {
            if (!pendingProposalAck) return;
            confirmMutation.mutate(
              { proposalId: pendingProposalAck.proposalId, input: { visibility, strength } },
            );
            setPendingProposalAck(null);
          }}
          residualAcknowledged={!pendingProposalAck?.needsAck}
        />
      ) : null}

      {pendingProposalAck === null && confirmMutation.isPending ? null : null}
    </div>
  );
}

type ProposalAdoptionCardProps = {
  tripId: string;
  planId: string;
  onCast: (decision: "ACCEPT" | "NEEDS_CHANGES") => void;
  outcome: { outcome: "CAST" | "ADOPTED" | "BLOCKED"; votesAccepted: number; votesRequired: number } | null;
};

function ProposalAdoptionCard({ planId, onCast, outcome }: ProposalAdoptionCardProps) {
  const t = useTranslations("teamOrchestration");
  const votes = usePlanAdoptionVotes(planId);
  const tally = outcome
    ?? (votes.data
      ? {
        outcome: "CAST" as const,
        votesAccepted: votes.data.votes.filter(v => v.decision === "ACCEPT").length,
        votesRequired: 0,
      }
      : null);

  return (
    <div className="rounded border bg-card p-3" data-testid={`proposal-card-${planId}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded bg-emerald-500 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            onClick={() => onCast("ACCEPT")}
            disabled={votes.isFetching}
          >
            <CheckCircle2 aria-hidden className="size-3" />
            {t("voteAccept")}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded bg-rose-500 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
            onClick={() => onCast("NEEDS_CHANGES")}
            disabled={votes.isFetching}
          >
            <X aria-hidden className="size-3" />
            {t("voteNeedsChanges")}
          </button>
        </div>
        <div className="text-xs text-muted-foreground">
          {tally
            ? `${tally.votesAccepted}/${tally.votesRequired}`
            : t("votesEmpty")}
        </div>
      </div>
      {outcome ? (
        <p className="mt-2 text-xs" data-testid={`proposal-outcome-${planId}`}>
          {outcome.outcome === "ADOPTED" && t("voteOutcomeAccepted")}
          {outcome.outcome === "BLOCKED" && t("voteOutcomeBlocked")}
          {outcome.outcome === "CAST" && t("voteOutcomeCast", { remaining: Math.max(0, outcome.votesRequired - outcome.votesAccepted) })}
        </p>
      ) : null}
    </div>
  );
}

type ConfirmationModalProps = {
  open: boolean;
  proposal: { id: string; destination: string };
  onCancel: () => void;
  onAcknowledge: () => void;
  onConfirm: (visibility: "TEAM_VISIBLE" | "ORCHESTRATOR_CONFIDENTIAL", strength: "HARD" | "SOFT") => void;
  residualAcknowledged: boolean;
};

function ConfirmationModal({ open, proposal, onCancel, onConfirm, onAcknowledge, residualAcknowledged }: ConfirmationModalProps) {
  const t = useTranslations("teamOrchestration");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="max-w-md rounded-md bg-background p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Confirm proposal · {proposal.destination}</h2>
        <p className="mt-3 text-sm text-amber-700">{t("residualInferenceWarning")}</p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={residualAcknowledged}
            onChange={(event) => event.target.checked ? onAcknowledge() : undefined}
            data-testid="residual-inference-ack"
          />
          {t("residualInferenceAck")}
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded bg-emerald-500 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            disabled={!residualAcknowledged}
            onClick={() => onConfirm("ORCHESTRATOR_CONFIDENTIAL", "HARD")}
          >
            {t("confirmProposal")} (confidential)
          </button>
          <button
            type="button"
            className="rounded bg-muted px-3 py-1 text-sm font-medium"
            onClick={() => onConfirm("TEAM_VISIBLE", "HARD")}
          >
            {t("confirmProposal")} (team)
          </button>
          <button
            type="button"
            className="rounded bg-rose-500 px-3 py-1 text-sm font-medium text-white"
            onClick={onCancel}
          >
            {t("dismissProposal")}
          </button>
        </div>
      </div>
    </div>
  );
}
