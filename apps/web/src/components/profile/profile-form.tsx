"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Save, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import type { Profile, UpdateProfileInput } from "@/lib/api/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export const profileFormSchema = z.object({
  nationality: z.string().max(64, "Use 64 characters or fewer"),
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
  saveError: string | null;
  saved: boolean;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { dirtyFields, errors, isDirty },
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileFormSchema),
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

  return (
    <form onSubmit={handleSubmit(submit, focusErrors)} noValidate className="space-y-8">
      {Object.keys(errors).length > 0 ? (
        <div id="profile-error-summary" tabIndex={-1} role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 outline-none focus-visible:ring-4 focus-visible:ring-destructive/20">
          <p className="font-semibold">Check the highlighted Profile fields.</p>
          <p className="mt-1 text-sm text-muted-foreground">Your changes have not been sent.</p>
        </div>
      ) : null}

      <section className="rounded-[22px] border bg-card p-5 shadow-[0_8px_24px_#102a4308] sm:p-7" aria-labelledby="travel-basics-heading">
        <SectionHeading id="travel-basics-heading" title="Travel basics" description="Private details used only by your Personal Agent until you explicitly share them for a trip." />
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field id="departure-city" label="Departure city" error={errors.departureCity?.message}>
            <input id="departure-city" {...register("departureCity")} className={inputClass(Boolean(errors.departureCity))} autoComplete="address-level2" />
          </Field>
          <Field id="nationality" label="Nationality" hint="Private; not shared in this slice." error={errors.nationality?.message}>
            <input id="nationality" {...register("nationality")} className={inputClass(Boolean(errors.nationality))} autoComplete="country-name" />
          </Field>
          <Field id="date-of-birth" label="Date of birth" hint="YYYY-MM-DD" error={errors.dateOfBirth?.message}>
            <input id="date-of-birth" {...register("dateOfBirth")} className={inputClass(Boolean(errors.dateOfBirth))} placeholder="YYYY-MM-DD" inputMode="numeric" />
          </Field>
          <Field id="available-departure-dates" label="Available departure dates" hint="Comma-separated YYYY-MM-DD dates" error={errors.availableDepartureDates?.message}>
            <input id="available-departure-dates" {...register("availableDepartureDates")} className={inputClass(Boolean(errors.availableDepartureDates))} placeholder="2026-10-03, 2026-10-10" />
          </Field>
        </div>
      </section>

      <section className="rounded-[22px] border bg-card p-5 shadow-[0_8px_24px_#102a4308] sm:p-7" aria-labelledby="preferences-heading">
        <SectionHeading id="preferences-heading" title="Preferences and comfort" description="Stable preferences can shape later recommendations without becoming shared trip data automatically." />
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field id="interests" label="Interests" hint="Comma-separated" error={errors.interests?.message}>
            <input id="interests" {...register("interests")} className={inputClass(Boolean(errors.interests))} placeholder="art, museums, local food" />
          </Field>
          <Field id="accommodation-style" label="Accommodation style" error={errors.accommodationStyle?.message}>
            <select id="accommodation-style" {...register("accommodationStyle")} className={inputClass(Boolean(errors.accommodationStyle))}>
              <option value="">Not set</option>
              <option value="city_center">City center</option>
              <option value="budget">Budget</option>
              <option value="luxury">Luxury</option>
            </select>
          </Field>
          <Field id="budget-max-usd" label="Maximum budget (USD)" error={errors.budgetMaxUsd?.message}>
            <input id="budget-max-usd" {...register("budgetMaxUsd")} className={inputClass(Boolean(errors.budgetMaxUsd))} inputMode="numeric" />
          </Field>
          <Field id="mobility-notes" label="Mobility notes" hint="Do not include document numbers." error={errors.mobilityNotes?.message}>
            <textarea id="mobility-notes" {...register("mobilityNotes")} className={cn(inputClass(Boolean(errors.mobilityNotes)), "min-h-28 py-3")} />
          </Field>
        </div>
        <label className="mt-6 flex min-h-11 items-center gap-3 rounded-2xl border px-4 py-3">
          <input type="checkbox" {...register("noRedEye")} className="size-5 accent-primary" />
          <span><span className="block font-medium">Avoid red-eye flights</span><span className="block text-sm text-muted-foreground">Treat overnight departures as a stable preference.</span></span>
        </label>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-background/95 p-4 shadow-lg backdrop-blur sm:sticky sm:bottom-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="size-4 text-primary" />
          Blank edited fields are preserved until the API supports clearing them.
        </div>
        <Button type="submit" size="lg" className="min-h-11 px-5" disabled={isSaving || !isDirty}>
          <Save aria-hidden="true" />
          {isSaving ? "Saving…" : "Save Profile"}
        </Button>
      </div>

      <div aria-live="polite" className="min-h-6 text-sm">
        {saved ? <p className="text-emerald-700">Profile saved. Your private snapshot is up to date.</p> : null}
        {saveError ? <p role="alert" className="text-destructive">{saveError} Your form input has been kept.</p> : null}
      </div>
    </form>
  );
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
    "min-h-11 w-full rounded-xl border bg-background px-3 text-base outline-none transition focus-visible:ring-4 focus-visible:ring-ring/30 sm:text-sm motion-reduce:transition-none",
    invalid && "border-destructive focus-visible:ring-destructive/20",
  );
}
