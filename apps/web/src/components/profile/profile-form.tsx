"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import type { Profile, UpdateProfileInput } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import { Button } from "@/components/ui/button";
import { SelectMenu } from "@/components/ui/select-menu";
import { cn } from "@/lib/utils";

const KNOWN_STATUS_KEYS = new Set([
  "401",
  "403",
  "404",
  "409",
  "422",
  "500",
  "502",
  "503",
]);

const datePattern = /^(?:\d{4}-\d{2}-\d{2}|\d{8})$/;

/**
 * Default schema factory used when no translator is available (tests, server
 * callers). UI consumers should use `makeProfileFormSchema(t)` so error
 * messages come from the active locale's `validation.*` keys.
 */
export const profileFormSchema = z.object({
  nationality: z.string().trim().min(1, "Required").max(64, "Use 64 characters or fewer"),
  dateOfBirth: z.union([z.literal(""), z.string().regex(datePattern, "Use YYYY-MM-DD")]),
  interests: z.string(),
  accommodationStyle: z.enum(["", "city_center", "budget", "luxury"]),
  budgetMaxUsd: z.union([z.literal(""), z.string().regex(/^\d+$/, "Enter a whole number")]),
  noRedEye: z.boolean(),
  mobilityNotes: z.string(),
  departureCity: z.string().max(64, "Use 64 characters or fewer"),
});

export type ProfileFormValues = z.infer<typeof profileFormSchema>;
export type ProfileDirtyFields = Partial<Record<keyof ProfileFormValues, boolean>>;

type Translator = ReturnType<typeof useTranslations>;

export function makeProfileFormSchema(t: Translator) {
  return z.object({
    // Required: hotel quotes are priced per nationality, and without one the
    // stay search returns nothing, the destination counts as uncovered, and the
    // whole trip is refused a plan. Asking here once is the only place this
    // belongs — the planning card should not have to stop and ask.
    nationality: z.string().trim().min(1, t("validation.required")).max(64, t("validation.max64")),
    dateOfBirth: z.union([z.literal(""), z.string().regex(datePattern, t("validation.datePattern"))]),
    interests: z.string(),
    accommodationStyle: z.enum(["", "city_center", "budget", "luxury"]),
    budgetMaxUsd: z.union([z.literal(""), z.string().regex(/^\d+$/, t("validation.wholeNumber"))]),
    noRedEye: z.boolean(),
    mobilityNotes: z.string(),
    departureCity: z.string().max(64, t("validation.max64")),
  });
}

export function profileToFormValues(profile: Profile): ProfileFormValues {
  return {
    nationality: profile.nationality ?? "",
    dateOfBirth: profile.dateOfBirth ?? "",
    interests: profile.interests?.join(", ") ?? "",
    accommodationStyle: profile.accommodationStyle ?? "",
    budgetMaxUsd: profile.budgetMaxUsd?.toString() ?? "",
    noRedEye: profile.noRedEye ?? false,
    mobilityNotes: profile.mobilityNotes ?? "",
    departureCity: profile.departureCity ?? "",
  };
}

export function toUpdateProfileInput(
  values: ProfileFormValues,
  dirtyFields: ProfileDirtyFields,
): UpdateProfileInput {
  const input: UpdateProfileInput = {};

  if (dirtyFields.nationality && values.nationality.trim()) input.nationality = values.nationality.trim();
  if (dirtyFields.dateOfBirth && values.dateOfBirth) input.dateOfBirth = normalizeDateOfBirth(values.dateOfBirth);
  if (dirtyFields.interests && splitList(values.interests).length) input.interests = splitList(values.interests);
  if (dirtyFields.accommodationStyle && values.accommodationStyle) input.accommodationStyle = values.accommodationStyle;
  if (dirtyFields.budgetMaxUsd && values.budgetMaxUsd) input.budgetMaxUsd = Number(values.budgetMaxUsd);
  if (dirtyFields.noRedEye) input.noRedEye = values.noRedEye;
  if (dirtyFields.mobilityNotes && values.mobilityNotes.trim()) input.mobilityNotes = values.mobilityNotes.trim();
  if (dirtyFields.departureCity && values.departureCity.trim()) input.departureCity = values.departureCity.trim();

  return input;
}

/** The API stores ISO dates; accept the compact form without leaking a second
 * representation into Profile, memory, or downstream consent flows. */
function normalizeDateOfBirth(value: string): string {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value;
}

export function ProfileForm({
  profile,
  onSave,
  isSaving,
  saveError,
  saved,
}: {
  profile: Profile;
  onSave: (input: UpdateProfileInput) => Promise<void>;
  isSaving: boolean;
  saveError: unknown;
  saved: boolean;
}) {
  const t = useTranslations("profile");
  const tErrors = useTranslations("errors");
  const schema = useMemo(() => makeProfileFormSchema(t), [t]);
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { dirtyFields, errors, isDirty },
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(schema),
    defaultValues: profileToFormValues(profile),
  });

  useEffect(() => {
    reset(profileToFormValues(profile));
  }, [profile, reset]);

  async function submit(values: ProfileFormValues) {
    const input = toUpdateProfileInput(values, dirtyFields);
    if (Object.keys(input).length === 0) return;
    await onSave(input);
  }

  function focusErrors() {
    window.requestAnimationFrame(() => {
      document.getElementById("profile-error-summary")?.focus();
    });
  }

  const errorMessage = saveError
    ? formatErrorMessage(saveError, tErrors, t("saveErrorSuffix"))
    : null;

  return (
    <form onSubmit={handleSubmit(submit, focusErrors)} noValidate className="space-y-4">
      {Object.keys(errors).length > 0 ? (
        <div id="profile-error-summary" tabIndex={-1} role="alert" className="border-2 border-destructive bg-destructive/5 p-4 outline-none wanderly-r-md focus-visible:ring-4 focus-visible:ring-destructive/20">
          <p className="font-semibold">{t("errorSummaryTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("errorSummaryBody")}</p>
        </div>
      ) : null}

      {/* One card. The two groups keep their own headings and landmarks; only
          the surrounding boxes merged, with a hairline rule where the seam
          used to be. */}
      {/* The padding sits on each half rather than on the card, so the rule
          between them can run edge to edge — it is the upper half's own bottom
          border, which puts it exactly on the seam. */}
      <div className="bg-card wanderly-edge wanderly-r-lg wanderly-shadow">
      <section aria-labelledby="travel-basics-heading" className="border-b border-dashed border-[var(--w-ink)]/35 p-4 sm:p-5">
        <SectionHeading id="travel-basics-heading" title={t("sectionBasicsTitle")} description={t("sectionBasicsDescription")} />
        <div className="mt-3 grid gap-x-3 gap-y-[6.5px] sm:grid-cols-3">
          <Field id="departure-city" label={t("fields.departureCity")} error={errors.departureCity?.message}>
            <input id="departure-city" {...register("departureCity")} className={inputClass(Boolean(errors.departureCity))} autoComplete="address-level2" />
          </Field>
          <Field id="nationality" label={t("fields.nationality")} error={errors.nationality?.message}>
            <input id="nationality" {...register("nationality")} className={inputClass(Boolean(errors.nationality))} placeholder={t("fields.nationalityPlaceholder")} autoComplete="country-name" />
          </Field>
          <Field id="date-of-birth" label={t("fields.dateOfBirth")} error={errors.dateOfBirth?.message}>
            <input id="date-of-birth" {...register("dateOfBirth")} className={inputClass(Boolean(errors.dateOfBirth))} placeholder={t("fields.dateOfBirthPlaceholder")} inputMode="numeric" />
          </Field>
        </div>
      </section>

      <section aria-labelledby="preferences-heading" className="p-4 sm:p-5">
        <SectionHeading id="preferences-heading" title={t("sectionPrefsTitle")} description={t("sectionPrefsDescription")} />
        <div className="mt-3 grid gap-x-3 gap-y-2 sm:grid-cols-[2fr_3fr]">
          {/* Left column, 2 of 5: the three short controls. */}
          <div className="flex flex-col gap-2">
          <Field id="accommodation-style" label={t("fields.accommodationStyle")} error={errors.accommodationStyle?.message}>
            <Controller
              control={control}
              name="accommodationStyle"
              render={({ field }) => (
                <SelectMenu
                  id="accommodation-style"
                  value={field.value}
                  onChange={field.onChange}
                  invalid={Boolean(errors.accommodationStyle)}
                  options={[
                    { value: "", label: t("accommodation.notSet") },
                    { value: "city_center", label: t("accommodation.city_center") },
                    { value: "budget", label: t("accommodation.budget") },
                    { value: "luxury", label: t("accommodation.luxury") },
                  ]}
                />
              )}
            />
          </Field>
          <Field id="budget-max-usd" label={t("fields.budgetMaxUsd")} error={errors.budgetMaxUsd?.message}>
            <input id="budget-max-usd" {...register("budgetMaxUsd")} className={inputClass(Boolean(errors.budgetMaxUsd))} inputMode="numeric" />
          </Field>
          <label className="flex min-h-11 items-center gap-3 bg-card px-4 py-3 wanderly-edge wanderly-r-md">
            <input type="checkbox" {...register("noRedEye")} className="size-5 accent-[var(--w-highlight)] wanderly-edge-thin wanderly-r-xs" />
            <span className="text-sm font-medium">{t("fields.noRedEyeLabel")}</span>
          </label>
          </div>

          {/* Right column, 3 of 5. The textarea takes the leftover height so
              both columns finish on the same line. */}
          <div className="flex flex-col gap-2">
            <Field id="interests" label={t("fields.interests")} error={errors.interests?.message}>
              <input id="interests" {...register("interests")} className={inputClass(Boolean(errors.interests))} placeholder={t("fields.interestsPlaceholder")} />
            </Field>
            <div className="flex flex-1 flex-col gap-1 text-sm font-medium">
              <label htmlFor="mobility-notes">{t("fields.mobilityNotes")}</label>
              <textarea id="mobility-notes" {...register("mobilityNotes")} className={cn(inputClass(Boolean(errors.mobilityNotes)), "min-h-24 flex-1 py-3")} placeholder={t("fields.mobilityNotesHint")} />
              {errors.mobilityNotes?.message ? <span className="text-xs text-destructive">{errors.mobilityNotes.message}</span> : null}
            </div>
          </div>
        </div>
      </section>
      </div>

      {/* The button at the form's bottom-right, not sticky: it used to ride
          the scroll and slide over the content below. The save status sits
          beside it rather than in a reserved strip underneath — that strip was
          blank almost always, and it was most of the gap before the next
          section. */}
      <div className="flex items-center justify-end gap-3">
        <div aria-live="polite" className="text-sm">
          {saved ? <p className="text-emerald-700">{t("savedToast")}</p> : null}
          {errorMessage ? <p role="alert" className="text-destructive">{errorMessage}</p> : null}
        </div>
        <Button type="submit" size="lg" className="min-h-11 px-5 wanderly-edge wanderly-r-md wanderly-shadow wanderly-press wanderly-action" disabled={isSaving || !isDirty}>
          <Save aria-hidden="true" />
          {isSaving ? t("saving") : t("save")}
        </Button>
      </div>
    </form>
  );
}

function formatErrorMessage(error: unknown, tErrors: (key: string) => string, suffix: string): string {
  // Inline mapping mirrors `useErrorMessage` so the form does not depend on
  // the hook (keeps the call-site order: useTranslations is the only hook
  // here, and its key prefix is stable).
  if (error instanceof TravelApiError) {
    if (error.isUnauthorized) return tErrors("unauthorized");
    if (error.statusCode !== null) {
      const key = String(error.statusCode);
      if (KNOWN_STATUS_KEYS.has(key)) return tErrors(`byStatusCode.${key}`) + " " + suffix;
      return tErrors("byStatusCode.fallback") + " " + suffix;
    }
    return (error.message || tErrors("byStatusCode.fallback")) + " " + suffix;
  }
  return tErrors("generic") + " " + suffix;
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function SectionHeading({ id, title, description }: { id: string; title: string; description: string }) {
  return <div><h2 id={id} className="text-xl font-semibold">{title}</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p></div>;
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  // Three subgrid rows — label, control, hint — so every control in a row
  // starts at the same line no matter how long its neighbour's hint runs.
  // Before this the cell stretched to the tallest sibling and the control
  // stretched with it, which is why a field with no hint sat lower and taller
  // than the two-line one beside it. `self-start` keeps a control at its own
  // height, so a tall textarea never inflates the input opposite it.
  return (
    <div className="row-span-3 grid grid-rows-subgrid gap-1 text-sm font-medium">
      <label htmlFor={id} className="self-end">{label}</label>
      {/* flex, not a plain block: a textarea is inline-level, so a block
          wrapper leaves a few pixels of baseline gap under it — enough to
          push the control opposite it out of alignment. */}
      <div className="flex flex-col self-start">{children}</div>
      <div className="self-start text-xs">
        {error ? <span className="text-destructive">{error}</span> : hint ? <span className="font-normal text-muted-foreground">{hint}</span> : null}
      </div>
    </div>
  );
}

function inputClass(invalid: boolean) {
  return cn(
    "min-h-11 w-full bg-card px-3 text-base outline-none wanderly-edge wanderly-r-sm sm:text-sm",
    invalid && "border-destructive",
  );
}
