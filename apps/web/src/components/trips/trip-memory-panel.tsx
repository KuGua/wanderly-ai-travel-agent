"use client";

import { Trash2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import type { TripMemoryFact } from "@/lib/api/contracts";
import {
  useDeleteTripMemory,
  useSaveTripMemoryGroupDecision,
  useSaveTripMemoryOverride,
  useTripMemoryGroupDecisions,
  useTripMemoryOverrides,
} from "@/lib/query/hooks";

/**
 * Trip memory: preferences that apply to this trip only.
 *
 * Two kinds, kept visually distinct because their audiences differ
 * (docs/long-term-memory-implementation.md §3.3):
 *
 * - "This trip" overrides are saved ORCHESTRATOR_CONFIDENTIAL: planning uses
 *   them, and the value is never shown to the rest of the team.
 * - Group decisions belong to the whole trip and every active member sees them.
 *
 * Neither touches the stable Profile. Saving here never rewrites what the user
 * has stated long-term, which is why the panel labels the scope on every row.
 */

/** Fields a member may set for a single trip, and the shape of each control. */
const OVERRIDE_FIELDS = [
  { key: "trip_pace", options: ["relaxed", "balanced", "packed"] },
  { key: "accommodation_style", options: ["city_center", "budget", "luxury"] },
] as const;

/** Fields the whole group may decide. Interests stay individual. */
const GROUP_FIELDS = [
  { key: "accommodation_style", options: ["city_center", "budget", "luxury"] },
  { key: "trip_pace", options: ["relaxed", "balanced", "packed"] },
] as const;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((item) => String(item)).join(" · ");
  return String(value);
}

export function TripMemoryPanel({ tripId }: { tripId: string }) {
  const t = useTranslations("trips.memory");
  const overridesQuery = useTripMemoryOverrides(tripId);
  const groupQuery = useTripMemoryGroupDecisions(tripId);
  const saveOverride = useSaveTripMemoryOverride(tripId);
  const saveGroupDecision = useSaveTripMemoryGroupDecision(tripId);
  const deleteMemory = useDeleteTripMemory(tripId);

  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<unknown>) {
    setBusyKey(key);
    try {
      await action();
    } finally {
      setBusyKey(null);
    }
  }

  if (overridesQuery.isPending || groupQuery.isPending) {
    return <LoadingState label={t("loading")} />;
  }
  if (overridesQuery.isError) {
    return <ErrorState error={overridesQuery.error} title={t("errorTitle")} />;
  }
  if (groupQuery.isError) {
    return <ErrorState error={groupQuery.error} title={t("errorTitle")} />;
  }

  const overrides = new Map(overridesQuery.data.overrides.map((fact) => [fact.fieldKey, fact]));
  const decisions = new Map(groupQuery.data.groupDecisions.map((fact) => [fact.fieldKey, fact]));

  return (
    <div className="p-3">
      <p className="text-[11px] font-black uppercase tracking-[0.09em] wanderly-underline">
        {t("overridesLabel")}
      </p>
      <p className="mt-1 text-[11px] text-[var(--w-muted)]">{t("overridesHint")}</p>

      <div className="mt-2 grid gap-2">
        {OVERRIDE_FIELDS.map((field) => (
          <MemoryRow
            key={`override-${field.key}`}
            scope="override"
            fieldKey={field.key}
            options={field.options}
            fact={overrides.get(field.key) ?? null}
            busy={busyKey === `override-${field.key}`}
            onSave={(value) => run(`override-${field.key}`, () =>
              saveOverride.mutateAsync({ fieldKey: field.key, value }))}
            onClear={(factId) => run(`override-${field.key}`, () => deleteMemory.mutateAsync(factId))}
          />
        ))}
      </div>

      <p className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.09em] wanderly-underline">
        <Users aria-hidden="true" className="size-3.5" /> {t("groupLabel")}
      </p>
      <p className="mt-1 text-[11px] text-[var(--w-muted)]">{t("groupHint")}</p>

      <div className="mt-2 grid gap-2">
        {GROUP_FIELDS.map((field) => (
          <MemoryRow
            key={`group-${field.key}`}
            scope="group"
            fieldKey={field.key}
            options={field.options}
            fact={decisions.get(field.key) ?? null}
            busy={busyKey === `group-${field.key}`}
            onSave={(value) => run(`group-${field.key}`, () =>
              saveGroupDecision.mutateAsync({ fieldKey: field.key, value }))}
            onClear={(factId) => run(`group-${field.key}`, () => deleteMemory.mutateAsync(factId))}
          />
        ))}
      </div>
    </div>
  );
}

function MemoryRow({
  scope,
  fieldKey,
  options,
  fact,
  busy,
  onSave,
  onClear,
}: {
  scope: "override" | "group";
  fieldKey: string;
  options: readonly string[];
  fact: TripMemoryFact | null;
  busy: boolean;
  onSave: (value: string) => void;
  onClear: (factId: string) => void;
}) {
  const t = useTranslations("trips.memory");
  const label = t(`fields.${fieldKey}` as "fields.trip_pace", { fallback: fieldKey });
  const selectId = `trip-memory-${scope}-${fieldKey}`;

  return (
    <div className="bg-card p-2 wanderly-edge-thin wanderly-r-xs">
      <label htmlFor={selectId} className="block text-[11px] font-bold">{label}</label>
      <div className="mt-1 flex items-center gap-1.5">
        <select
          id={selectId}
          value={fact ? String(fact.value) : ""}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value) onSave(event.target.value);
          }}
          className="min-w-0 flex-1 bg-background px-1.5 py-1 text-[11px] disabled:opacity-50 wanderly-edge-thin wanderly-r-xs"
        >
          <option value="">{t("unset")}</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {t(`values.${option}` as "values.relaxed", { fallback: option })}
            </option>
          ))}
        </select>
        {fact ? (
          <button
            type="button"
            aria-label={t("clearAria", { field: label })}
            disabled={busy}
            onClick={() => onClear(fact.id)}
            className="grid size-7 shrink-0 place-items-center bg-card text-[var(--w-ink)] disabled:opacity-50 wanderly-edge-thin wanderly-r-xs wanderly-press"
          >
            <Trash2 aria-hidden="true" className="size-3" />
          </button>
        ) : null}
      </div>
      {fact ? (
        <p className="mt-1 text-[10px] text-[var(--w-muted)]">
          {fact.kind === "GROUP_DECISION" ? t("scopeGroup") : t("scopeThisTrip")}
          {" · "}
          {formatValue(fact.value)}
        </p>
      ) : null}
    </div>
  );
}
