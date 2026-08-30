"use client";

import { LockKeyhole } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link } from "@/i18n/navigation";
import type { UpdateProfileInput } from "@/lib/api/contracts";
import { useMyProfile, useUpdateMyProfile } from "@/lib/query/hooks";
import { ProfileForm } from "./profile-form";
import { ProfileMemory } from "./profile-memory";

export function ProfilePageContent() {
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const profileQuery = useMyProfile();
  const mutation = useUpdateMyProfile();
  const [saved, setSaved] = useState(false);

  async function save(input: UpdateProfileInput) {
    setSaved(false);
    await mutation.mutateAsync(input);
    setSaved(true);
  }

  return (
    <main className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 md:px-[clamp(2rem,4vw,3.5rem)] md:py-[42px]">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.11em] text-primary">
            <LockKeyhole aria-hidden="true" className="size-4" /> {t("kicker")}
          </p>
          <h1 className="mt-2 text-[clamp(2.25rem,5vw,3rem)] font-bold leading-none tracking-[-0.055em]">{t("title")}</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">{t("subtitle")}</p>
        </div>
      </header>

      <div className="mt-10">
        {profileQuery.isPending ? <LoadingState label={tCommon("loadingProfileCapital")} /> : null}
        {profileQuery.isError ? <ErrorState error={profileQuery.error} title={t("errorSummaryTitle")} /> : null}
        {profileQuery.data?.profile ? (
          <ProfileForm
            profile={profileQuery.data.profile}
            onSave={save}
            isSaving={mutation.isPending}
            saveError={mutation.isError ? mutation.error : null}
            saved={saved}
          />
        ) : null}
        {profileQuery.data?.profile === null ? (
          <section className="border-2 border-dashed border-[var(--w-ink)] bg-card p-8 wanderly-r-lg">
            <h2 className="text-xl font-semibold">{t("emptyTitle")}</h2>
            <p className="mt-3 max-w-xl text-muted-foreground">{t("emptyBody")}</p>
            <Link href="/home" className="mt-6 inline-flex min-h-11 items-center font-extrabold text-[var(--w-ink)] wanderly-underline">
              {t("emptyAction")}
            </Link>
          </section>
        ) : null}
      </div>

      {/* Long-term memory sits below the form: the form is where facts are
          stated, this is what the assistant has retained and what it wants to
          ask about. */}
      <ProfileMemory />
    </main>
  );
}
