"use client";

import { Check, Sparkles, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import type { MemoryFact, MemorySuggestion } from "@/lib/api/contracts";
import {
  useConfirmMemoryProposal,
  useDeleteMemoryFact,
  useDismissMemoryProposal,
  useProfileMemory,
} from "@/lib/query/hooks";

/**
 * Profile memory: what the assistant has remembered, and what it would like to
 * ask about.
 *
 * Per docs/long-term-memory-implementation.md §5.4 a suggestion card shows only
 * the current setting, the candidate value, and how many independent
 * observations sit behind it. Timestamps, trip names, activation, decay and
 * internal evidence ids are never displayed — the API does not return them, so
 * this component could not leak them even by mistake.
 *
 * Cards are non-blocking: ignoring one is a valid outcome and it expires on
 * its own.
 */

/** Renders a stored value without inventing formatting the API did not send. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(" · ");
  if (typeof value === "boolean") return String(value);
  return String(value);
}

export function ProfileMemory() {
  const t = useTranslations("profile.memory");
  const memoryQuery = useProfileMemory();
  const deleteFact = useDeleteMemoryFact();
  const confirmProposal = useConfirmMemoryProposal();
  const dismissProposal = useDismissMemoryProposal();

  // Which card is mid-flight, so only that one shows a pending state.
  const [busyId, setBusyId] = useState<string | null>(null);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  }

  if (memoryQuery.isPending) return <LoadingState label={t("loading")} />;
  if (memoryQuery.isError) return <ErrorState error={memoryQuery.error} title={t("errorTitle")} />;

  const { facts, suggestions } = memoryQuery.data;
  const activeFacts = facts.filter((fact) => fact.status === "ACTIVE");
  const currentByField = new Map(activeFacts.map((fact) => [fact.fieldKey, fact]));

  return (
    <section className="mt-10" aria-labelledby="memory-heading">
      <div className="mb-3">
        <p className="text-[11px] font-black uppercase tracking-[0.11em] wanderly-underline">
          {t("kicker")}
        </p>
        <h2 id="memory-heading" className="mt-1 text-xl font-bold tracking-[-0.035em]">
          {t("heading")}
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-[var(--w-muted)]">{t("body")}</p>
      </div>

      {suggestions.length > 0 ? (
        <ul className="mb-5 grid gap-3" role="list" aria-label={t("suggestionsAriaLabel")}>
          {suggestions.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              current={currentByField.get(suggestion.fieldKey) ?? null}
              busy={busyId === suggestion.id}
              onConfirm={() => run(suggestion.id, () => confirmProposal.mutateAsync(suggestion.id))}
              onDismiss={() => run(suggestion.id, () => dismissProposal.mutateAsync(suggestion.id))}
            />
          ))}
        </ul>
      ) : null}

      {activeFacts.length === 0 ? (
        <div className="border-2 border-dashed border-[var(--w-ink)] bg-card p-6 text-center wanderly-r-lg">
          <p className="font-bold">{t("emptyTitle")}</p>
          <p className="mt-1 text-sm text-[var(--w-muted)]">{t("emptyBody")}</p>
        </div>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2" role="list" aria-label={t("factsAriaLabel")}>
          {activeFacts.map((fact) => (
            <li
              key={fact.id}
              className="flex items-start justify-between gap-3 bg-card p-4 wanderly-edge wanderly-r-md wanderly-shadow-sm"
            >
              <div className="min-w-0">
                <p className="text-[11px] font-black uppercase tracking-[0.09em] text-[var(--w-muted)]">
                  {t(`fields.${fact.fieldKey}` as "fields.trip_pace", { fallback: fact.fieldKey })}
                </p>
                <p className="mt-0.5 break-words font-bold">{formatValue(fact.value)}</p>
                <p className="mt-1 text-[11px] text-[var(--w-muted)]">
                  {fact.source === "PROFILE_FORM" ? t("sourceStated") : t("sourceConfirmed")}
                </p>
              </div>
              <button
                type="button"
                aria-label={t("deleteAria")}
                disabled={busyId === fact.id}
                onClick={() => run(fact.id, () => deleteFact.mutateAsync(fact.id))}
                className="grid size-9 shrink-0 place-items-center bg-card text-[var(--w-ink)] disabled:opacity-50 wanderly-edge-thin wanderly-r-xs wanderly-press"
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestionCard({
  suggestion,
  current,
  busy,
  onConfirm,
  onDismiss,
}: {
  suggestion: MemorySuggestion;
  current: MemoryFact | null;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("profile.memory");
  const fieldLabel = t(`fields.${suggestion.fieldKey}` as "fields.trip_pace", {
    fallback: suggestion.fieldKey,
  });

  return (
    <li className="bg-[var(--w-mist)] p-4 wanderly-edge wanderly-r-md wanderly-shadow">
      <p className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.09em]">
        <Sparkles aria-hidden="true" className="size-3.5" />
        {t("suggestionKicker")}
      </p>

      <p className="mt-2 text-sm">
        {current
          ? t("suggestionBodyWithCurrent", {
              field: fieldLabel,
              current: formatValue(current.value),
              candidate: formatValue(suggestion.value),
            })
          : t("suggestionBody", { field: fieldLabel, candidate: formatValue(suggestion.value) })}
      </p>

      {/* Aggregate evidence only — never dates, trips or a score. */}
      <p className="mt-1.5 text-xs text-[var(--w-muted)]">
        {t("evidence", { count: suggestion.observationCount })}
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="inline-flex min-h-10 items-center gap-1.5 px-3 text-sm font-extrabold disabled:opacity-50 wanderly-edge wanderly-r-md wanderly-shadow-sm wanderly-press wanderly-action"
        >
          <Check aria-hidden="true" className="size-4" /> {t("confirm")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="inline-flex min-h-10 items-center gap-1.5 bg-card px-3 text-sm font-bold disabled:opacity-50 wanderly-edge wanderly-r-md wanderly-shadow-sm wanderly-press"
        >
          <X aria-hidden="true" className="size-4" /> {t("notNow")}
        </button>
      </div>
    </li>
  );
}
