"use client";

import { Check, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { MemoryFact, MemorySuggestion } from "@/lib/api/contracts";
import {
  useConfirmMemoryProposal,
  useDismissMemoryProposal,
  useProfileMemory,
} from "@/lib/query/hooks";

/**
 * What the assistant would like to ask about.
 *
 * This used to also list every remembered fact and every free-text note the
 * owner had kept. Both lists are gone from the page: they restated what the
 * form above already shows, and the notes turned a handful of highlights into
 * a wall of one-line cards. Nothing was removed from the server — the facts,
 * the notes, their endpoints and their delete routes are all still there, and
 * so are the client hooks that reach them, so putting either list back is a
 * matter of rendering it again.
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

  // A question nobody asked for is not worth a loading row or an error box on
  // the profile page: with no pending suggestion this section is silent, so a
  // slow or failed fetch is silent too.
  if (memoryQuery.isPending || memoryQuery.isError) return null;

  const { facts, suggestions } = memoryQuery.data;
  if (suggestions.length === 0) return null;

  const activeFacts = facts.filter((fact) => fact.status === "ACTIVE");
  const currentByField = new Map(activeFacts.map((fact) => [fact.fieldKey, fact]));

  return (
    <ul className="mt-5 grid gap-3" role="list" aria-label={t("suggestionsAriaLabel")}>
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
