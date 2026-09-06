"use client";

import { ArrowRight, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import type { PreferenceCardField } from "@/lib/api/contracts";

/**
 * The preference card — a trip's one chance to ask whether the traveller's
 * profile is right for *this* trip, before the assistant plans anything around
 * the wrong assumption.
 *
 * Read as a piece of white paper: square corners and a thin 1.5px ink outline.
 * The grain runs coarser (`0.6`) and slightly louder (`0.09`) than the chat's
 * other cards so the texture reads as fibre rather than noise.
 */
const PAPER_GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.6' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23g)' opacity='0.35'/%3E%3C/svg%3E\")";

const inputFieldClass =
  "w-full bg-[var(--w-mist)] px-2 py-1 text-sm text-[var(--w-ink)] outline-none wanderly-edge-thin wanderly-r-xs focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60";

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

function displayValue(
  value: unknown,
  unset: string,
  optionLabel?: (option: string) => string,
): string {
  if (value === null || value === undefined || value === "") return unset;
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "✓" : "—";
  // A closed-set value is a stored token, not prose: without this the card
  // showed the traveller `city_center` where it means "City center".
  if (optionLabel && typeof value === "string") return optionLabel(value);
  return String(value);
}

/**
 * Turns a stored option token into the label the profile form already uses for
 * it. Falls back to the humanised token so an option added to the catalogue
 * before its label still reads as words rather than breaking the card.
 */
function optionLabel(
  option: string,
  translate: ReturnType<typeof useTranslations>,
): string {
  // `t()` does not throw on a missing message — it returns a placeholder and
  // logs — so the fallback has to be chosen by asking first.
  return translate.has(option) ? translate(option) : option.replace(/_/g, " ");
}

/**
 * Turns what was typed into the type the catalogue validates against.
 *
 * An empty box means "leave it unset" rather than an empty string or a NaN,
 * and a number that has not finished being typed ("1", then "12") stays a
 * number rather than becoming NaN and failing the save.
 */
function parseByKind(kind: PreferenceCardField["kind"], typed: string): unknown {
  const trimmed = typed.trim();
  if (kind === "list") {
    return trimmed.split(/[、,，]/).map((part) => part.trim()).filter(Boolean);
  }
  if (kind === "number") {
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return typed;
}

function isUnset(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

export function TripPreferenceCard({
  fields,
  saving,
  onSubmit,
  onDismiss,
}: {
  fields: PreferenceCardField[];
  saving: boolean;
  onSubmit: (adjustments: Array<{ fieldKey: string; value: unknown }>) => void;
  onDismiss: () => void;
}): ReactNode {
  const t = useTranslations("explore.chat");
  const fieldLabel = useTranslations("explore.chat.prefCardField");
  // One namespace already carries every closed-set option this card can show
  // — both the stay styles and the pace values — so reuse it rather than
  // restate the labels or guess a namespace per field.
  const optionLabels = useTranslations("trips.memory.values");
  // This card is a form, not a read-only summary. Opening straight into edit
  // mode leaves one unambiguous action at the bottom: "Use these" persists
  // the changes; the X closes without applying them.
  const [editing] = useState(true);
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
      className="relative isolate mx-auto mb-[18px] w-full max-w-[420px] bg-card px-6 py-5 text-sm text-[var(--w-ink)] rounded-none wanderly-edge-thin"
    >
      {/* Grain sits above the ground and below the text, and takes no clicks.
          `mix-blend-overlay` lets the neutral grayscale noise read as paper
          texture in both light and dark mode. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[1] mix-blend-overlay"
        style={{ backgroundImage: PAPER_GRAIN, opacity: 0.09 }}
      />
      <div className="relative z-[2] flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-extrabold leading-tight">{t("prefCardTitle")}</h3>
          <p className="mt-1.5 max-w-[34ch] text-xs leading-snug text-muted-foreground">{t("prefCardIntro")}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          disabled={saving}
          aria-label={t("prefCardClose")}
          title={t("prefCardClose")}
          className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>

      <dl className="relative z-[2] mt-3 flex flex-col">
        {fields.map((field) => {
          const current = valueOf(field);
          const changed = Object.hasOwn(draft, field.fieldKey) && draft[field.fieldKey] !== field.value;
          const unset = isUnset(current);
          return (
            <div
              key={field.fieldKey}
              className="flex items-baseline gap-3 border-t border-border py-2.5 first:border-t-0"
            >
              <dt className="w-[7rem] shrink-0 text-xs font-bold text-foreground">
                {labelFor(fieldLabel, field.fieldKey)}
              </dt>
              <dd className="min-w-0 flex-1 text-sm">
                {editing ? (
                  field.options ? (
                    <select
                      aria-label={field.fieldKey}
                      value={typeof current === "string" ? current : ""}
                      onChange={(event) => setDraft((d) => ({ ...d, [field.fieldKey]: event.target.value }))}
                      className={inputFieldClass}
                    >
                      <option value="">{t("prefCardUnset")}</option>
                      {field.options.map((option) => (
                        <option key={option} value={option}>{optionLabel(option, optionLabels)}</option>
                      ))}
                    </select>
                  ) : field.kind === "boolean" ? (
                    <input
                      aria-label={field.fieldKey}
                      type="checkbox"
                      checked={current === true}
                      onChange={(event) => setDraft((d) => ({ ...d, [field.fieldKey]: event.target.checked }))}
                      className="size-4 accent-primary"
                    />
                  ) : (
                    <input
                      aria-label={field.fieldKey}
                      type={field.kind === "number" ? "number" : "text"}
                      inputMode={field.kind === "number" ? "numeric" : undefined}
                      step={field.fieldKey === "budget_max_usd" ? 1000 : undefined}
                      value={Array.isArray(current) ? current.join("、") : String(current ?? "")}
                      // Keyed off the field's declared kind, not the value on
                      // screen. Every field is null until it is first set, so
                      // reading the value sent a plain string for all of them:
                      // `interests` wants an array and `budget_max_usd` a
                      // number, and each rejection failed the whole save —
                      // taking the card's "seen" marker, and the answer, with
                      // it.
                      onChange={(event) => setDraft((d) => ({
                        ...d,
                        [field.fieldKey]: parseByKind(field.kind, event.target.value),
                      }))}
                      className={inputFieldClass}
                    />
                  )
                ) : (
                  <span className={unset ? "text-muted-foreground/70" : undefined}>
                    {displayValue(current, t("prefCardUnset"), field.options
                      ? (option) => optionLabel(option, optionLabels)
                      : undefined)}
                  </span>
                )}
                {!editing && changed ? (
                  <span className="ml-2 inline-flex items-center bg-primary px-1.5 py-px text-[10px] font-extrabold uppercase tracking-wider text-[var(--w-ink)]">
                    {t("prefCardAdjusted")}
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>

      {!editing ? (
        <p className="relative z-[2] mt-3 text-[11px] leading-snug text-muted-foreground/80">
          {t("prefCardReopenHint")}
        </p>
      ) : null}

      <div className="relative z-[2] mt-4 flex justify-end">
        <button
          type="button"
          data-testid="trip-preference-submit"
          disabled={saving}
          onClick={submit}
          className="inline-flex min-h-11 items-center gap-1 text-xs font-extrabold text-[var(--w-ink)] underline decoration-2 underline-offset-4 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? t("prefCardSaving") : t("prefCardSubmit")}
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </section>
  );
}
