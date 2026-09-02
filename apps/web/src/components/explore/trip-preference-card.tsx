"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import type { PreferenceCardField } from "@/lib/api/contracts";

/**
 * The preference card — a trip's one chance to ask whether the traveller's
 * profile is right for *this* trip, before the assistant plans anything around
 * the wrong assumption.
 *
 * Deliberately unlike everything around it. The chat is drawn with a hard
 * edge, an uneven radius and a black offset shadow; this is a card lying on
 * top of that — square, borderless, a shadow you can barely see, and a paper
 * grain fine enough to read as texture rather than pattern. It should feel
 * handed to you, not built into the page.
 *
 * The grain is one inline SVG turbulence, so it costs no request and cannot
 * fail to load. Kept under 4% opacity: any more and it reads as noise.
 */
const PAPER_GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23g)' opacity='0.35'/%3E%3C/svg%3E\")";

/**
 * The catalogue key is a storage name; a card is read by a person. Falls back
 * to the key rather than blanking, so a field added to the catalogue before
 * its label still shows up.
 */
function labelFor(translate: (key: string) => string, fieldKey: string): string {
  try {
    return translate(fieldKey);
  } catch {
    return fieldKey.replace(/_/g, " ");
  }
}

function displayValue(value: unknown, unset: string): string {
  if (value === null || value === undefined || value === "") return unset;
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "✓" : "—";
  return String(value);
}

export function TripPreferenceCard({
  fields,
  saving,
  onSubmit,
}: {
  fields: PreferenceCardField[];
  saving: boolean;
  onSubmit: (adjustments: Array<{ fieldKey: string; value: unknown }>) => void;
}): ReactNode {
  const t = useTranslations("explore.chat");
  const fieldLabel = useTranslations("explore.chat.prefCardField");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  const valueOf = (field: PreferenceCardField) =>
    Object.hasOwn(draft, field.fieldKey) ? draft[field.fieldKey] : field.value;

  function submit() {
    // Only what the traveller actually changed. Writing every field would
    // pin the whole set to this trip, and a later profile edit would stop
    // reaching a trip the traveller never meant to detach.
    const adjustments = fields
      .filter((field) => Object.hasOwn(draft, field.fieldKey) && draft[field.fieldKey] !== field.value)
      .map((field) => ({ fieldKey: field.fieldKey, value: draft[field.fieldKey] }));
    onSubmit(adjustments);
  }

  return (
    <section
      data-testid="trip-preference-card"
      aria-label={t("prefCardTitle")}
      className="relative mx-auto mb-[18px] w-full max-w-[420px] bg-[var(--w-paper,#FBFAF7)] px-6 py-5 text-[var(--w-ink)]"
      style={{ boxShadow: "0 1px 2px rgba(20,24,28,.05), 0 8px 24px -12px rgba(20,24,28,.14)" }}
    >
      {/* Grain sits above the ground and below the text, and takes no clicks. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 mix-blend-multiply"
        style={{ backgroundImage: PAPER_GRAIN, opacity: 0.035 }}
      />

      <div className="relative flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-bold leading-tight">{t("prefCardTitle")}</h3>
          <p className="mt-1.5 max-w-[34ch] text-[11.5px] leading-[1.55] text-[var(--w-ink)]/55">
            {t("prefCardIntro")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing((current) => !current)}
          className="shrink-0 text-[11px] font-bold text-[var(--w-ink)]/50 underline-offset-4 hover:text-[var(--w-ink)] hover:underline"
        >
          {editing ? t("prefCardDone") : t("prefCardEdit")}
        </button>
      </div>

      <dl className="relative mt-4 flex flex-col">
        {fields.map((field) => {
          const current = valueOf(field);
          const changed = Object.hasOwn(draft, field.fieldKey) && draft[field.fieldKey] !== field.value;
          return (
            <div key={field.fieldKey} className="flex items-baseline gap-3 border-t border-[var(--w-ink)]/8 py-2.5 first:border-t-0">
              <dt className="w-[8.5rem] shrink-0 text-[12px] font-semibold text-[var(--w-ink)]/50">
                {labelFor(fieldLabel, field.fieldKey)}
              </dt>
              <dd className="min-w-0 flex-1 text-[13px]">
                {editing ? (
                  field.options ? (
                    <select
                      aria-label={field.fieldKey}
                      value={typeof current === "string" ? current : ""}
                      onChange={(event) => setDraft((d) => ({ ...d, [field.fieldKey]: event.target.value }))}
                      className="w-full bg-transparent py-0.5 text-[13px] text-[var(--w-ink)] outline-none"
                    >
                      <option value="">{t("prefCardUnset")}</option>
                      {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : typeof field.value === "boolean" ? (
                    <input
                      aria-label={field.fieldKey}
                      type="checkbox"
                      checked={current === true}
                      onChange={(event) => setDraft((d) => ({ ...d, [field.fieldKey]: event.target.checked }))}
                    />
                  ) : (
                    <input
                      aria-label={field.fieldKey}
                      type="text"
                      value={Array.isArray(current) ? current.join("、") : String(current ?? "")}
                      onChange={(event) => setDraft((d) => ({
                        ...d,
                        [field.fieldKey]: Array.isArray(field.value)
                          ? event.target.value.split(/[、,]/).map((part) => part.trim()).filter(Boolean)
                          : event.target.value,
                      }))}
                      className="w-full bg-transparent py-0.5 text-[13px] text-[var(--w-ink)] outline-none"
                    />
                  )
                ) : (
                  <span className={current === null || current === undefined || current === "" ? "text-[var(--w-ink)]/35" : undefined}>
                    {displayValue(current, t("prefCardUnset"))}
                  </span>
                )}
              </dd>
              <span className="shrink-0 text-[10px] text-[var(--w-ink)]/35">
                {changed || !field.inherited ? t("prefCardAdjusted") : t("prefCardInherited")}
              </span>
            </div>
          );
        })}
      </dl>

      <div className="relative mt-5 flex justify-center">
        <button
          type="button"
          data-testid="trip-preference-submit"
          disabled={saving}
          onClick={submit}
          className="min-h-9 rounded-none bg-[var(--w-ink)] px-7 text-[12px] font-bold text-[var(--w-paper,#FBFAF7)] disabled:opacity-45"
        >
          {saving ? t("prefCardSaving") : t("prefCardSubmit")}
        </button>
      </div>
    </section>
  );
}
