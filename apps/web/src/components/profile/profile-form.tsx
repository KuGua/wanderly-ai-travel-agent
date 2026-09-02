"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Save, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import type { Profile, UpdateProfileInput } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import { Button } from "@/components/ui/button";
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

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

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
  availableDepartureDates: z.string().refine(
    (value) => splitList(value).every((date) => datePattern.test(date)),
    "Use YYYY-MM-DD dates separated by commas",
  ),
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
    availableDepartureDates: z.string().refine(
      (value) => splitList(value).every((date) => datePattern.test(date)),
      t("validation.datesList"),
    ),
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
    availableDepartureDates: profile.availableDepartureDates?.join(", ") ?? "",
    departureCity: profile.departureCity ?? "",
  };
}

export function toUpdateProfileInput(
  values: ProfileFormValues,
  dirtyFields: ProfileDirtyFields,
): UpdateProfileInput {
  const input: UpdateProfileInput = {};

  if (dirtyFields.nationality && values.nationality.trim()) input.nationality = values.nationality.trim();
  if (dirtyFields.dateOfBirth && values.dateOfBirth) input.dateOfBirth = values.dateOfBirth;
  if (dirtyFields.interests && splitList(values.interests).length) input.interests = splitList(values.interests);
  if (dirtyFields.accommodationStyle && values.accommodationStyle) input.accommodationStyle = values.accommodationStyle;
  if (dirtyFields.budgetMaxUsd && values.budgetMaxUsd) input.budgetMaxUsd = Number(values.budgetMaxUsd);
  if (dirtyFields.noRedEye) input.noRedEye = values.noRedEye;
  if (dirtyFields.mobilityNotes && values.mobilityNotes.trim()) input.mobilityNotes = values.mobilityNotes.trim();
  if (dirtyFields.availableDepartureDates && splitList(values.availableDepartureDates).length) {
    input.availableDepartureDates = splitList(values.availableDepartureDates);
  }
  if (dirtyFields.departureCity && values.departureCity.trim()) input.departureCity = values.departureCity.trim();

  return input;
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
    <form onSubmit={handleSubmit(submit, focusErrors)} noValidate className="space-y-8">
      {Object.keys(errors).length > 0 ? (
        <div id="profile-error-summary" tabIndex={-1} role="alert" className="border-2 border-destructive bg-destructive/5 p-4 outline-none wanderly-r-md focus-visible:ring-4 focus-visible:ring-destructive/20">
          <p className="font-semibold">{t("errorSummaryTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("errorSummaryBody")}</p>
        </div>
      ) : null}

      <section className="bg-card p-5 wanderly-edge wanderly-r-lg wanderly-shadow sm:p-7" aria-labelledby="travel-basics-heading">
        <SectionHeading id="travel-basics-heading" title={t("sectionBasicsTitle")} description={t("sectionBasicsDescription")} />
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field id="departure-city" label={t("fields.departureCity")} error={errors.departureCity?.message}>
            <input id="departure-city" {...register("departureCity")} className={inputClass(Boolean(errors.departureCity))} autoComplete="address-level2" />
          </Field>
          <Field id="nationality" label={t("fields.nationality")} hint={t("fields.nationalityHint")} error={errors.nationality?.message}>
            <input id="nationality" {...register("nationality")} className={inputClass(Boolean(errors.nationality))} autoComplete="country-name" />
          </Field>
          <Field id="date-of-birth" label={t("fields.dateOfBirth")} hint={t("fields.dateOfBirthHint")} error={errors.dateOfBirth?.message}>
            <input id="date-of-birth" {...register("dateOfBirth")} className={inputClass(Boolean(errors.dateOfBirth))} placeholder={t("fields.dateOfBirthPlaceholder")} inputMode="numeric" />
          </Field>
          <Field id="available-departure-dates" label={t("fields.availableDepartureDates")} hint={t("fields.availableDepartureDatesHint")} error={errors.availableDepartureDates?.message}>
            <input id="available-departure-dates" {...register("availableDepartureDates")} className={inputClass(Boolean(errors.availableDepartureDates))} placeholder={t("fields.availableDepartureDatesPlaceholder")} />
          </Field>
        </div>
      </section>

      <section className="bg-card p-5 wanderly-edge wanderly-r-lg wanderly-shadow sm:p-7" aria-labelledby="preferences-heading">
        <SectionHeading id="preferences-heading" title={t("sectionPrefsTitle")} description={t("sectionPrefsDescription")} />
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field id="interests" label={t("fields.interests")} hint={t("fields.interestsHint")} error={errors.interests?.message}>
            <input id="interests" {...register("interests")} className={inputClass(Boolean(errors.interests))} placeholder={t("fields.interestsPlaceholder")} />
          </Field>
          <Field id="accommodation-style" label={t("fields.accommodationStyle")} error={errors.accommodationStyle?.message}>
            <select id="accommodation-style" {...register("accommodationStyle")} className={inputClass(Boolean(errors.accommodationStyle))}>
              <option value="">{t("accommodation.notSet")}</option>
              <option value="city_center">{t("accommodation.city_center")}</option>
              <option value="budget">{t("accommodation.budget")}</option>
              <option value="luxury">{t("accommodation.luxury")}</option>
            </select>
          </Field>
          <Field id="budget-max-usd" label={t("fields.budgetMaxUsd")} error={errors.budgetMaxUsd?.message}>
            <input id="budget-max-usd" {...register("budgetMaxUsd")} className={inputClass(Boolean(errors.budgetMaxUsd))} inputMode="numeric" />
          </Field>
          <Field id="mobility-notes" label={t("fields.mobilityNotes")} hint={t("fields.mobilityNotesHint")} error={errors.mobilityNotes?.message}>
            <textarea id="mobility-notes" {...register("mobilityNotes")} className={cn(inputClass(Boolean(errors.mobilityNotes)), "min-h-28 py-3")} />
          </Field>
        </div>
        <label className="mt-6 flex min-h-11 items-center gap-3 bg-card px-4 py-3 wanderly-edge wanderly-r-md wanderly-shadow-sm">
          <input type="checkbox" {...register("noRedEye")} className="size-5 accent-[var(--w-highlight)] wanderly-edge-thin wanderly-r-xs" />
          <span>
            <span className="block font-medium">{t("fields.noRedEyeLabel")}</span>
            <span className="block text-sm text-muted-foreground">{t("fields.noRedEyeHint")}</span>
          </span>
        </label>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4 bg-card p-4 wanderly-edge wanderly-r-lg wanderly-shadow sm:sticky sm:bottom-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="size-4 text-[var(--w-ink)]" />
          {t("stickyNote")}
        </div>
        <Button type="submit" size="lg" className="min-h-11 px-5 wanderly-edge wanderly-r-md wanderly-shadow-sm wanderly-press wanderly-action" disabled={isSaving || !isDirty}>
          <Save aria-hidden="true" />
          {isSaving ? t("saving") : t("save")}
        </Button>
      </div>

      <div aria-live="polite" className="min-h-6 text-sm">
        {saved ? <p className="text-emerald-700">{t("savedToast")}</p> : null}
        {errorMessage ? <p role="alert" className="text-destructive">{errorMessage}</p> : null}
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
  return <div><h2 id={id} className="text-xl font-semibold">{title}</h2><p className="mt-2 max-w-2xl text-sm text-muted-foreground">{description}</p></div>;
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 text-sm font-medium">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <span className="text-xs text-destructive">{error}</span> : hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function inputClass(invalid: boolean) {
  return cn(
    "min-h-11 w-full bg-card px-3 text-base outline-none wanderly-edge wanderly-r-sm sm:text-sm",
    invalid && "border-destructive",
  );
}