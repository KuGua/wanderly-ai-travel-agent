"use client";

import { LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { DemoDataBadge, ErrorState, LoadingState } from "@/components/ui/data-state";
import { getErrorMessage } from "@/lib/api/errors";
import type { UpdateProfileInput } from "@/lib/api/contracts";
import { useMyProfile, useUpdateMyProfile } from "@/lib/query/hooks";
import { useDataMode } from "@/lib/query/provider";
import { ProfileForm } from "./profile-form";

export function ProfilePageContent() {
  const mode = useDataMode();
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
          <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.11em] text-primary"><LockKeyhole aria-hidden="true" className="size-4" /> Private Profile</p>
          <h1 className="mt-2 text-[clamp(2.25rem,5vw,3rem)] font-bold leading-none tracking-[-0.055em]">Travel preference</h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">Nothing here is shared with a trip unless a later consent flow records that choice. Passport numbers are never collected.</p>
        </div>
        {mode === "fixture" ? <DemoDataBadge /> : null}
      </header>

      <div className="mt-10">
        {profileQuery.isPending ? <LoadingState label="Loading your private Profile" /> : null}
        {profileQuery.isError ? <ErrorState error={profileQuery.error} title="Profile unavailable" /> : null}
        {profileQuery.data?.profile ? (
          <ProfileForm
            profile={profileQuery.data.profile}
            onSave={save}
            isSaving={mutation.isPending}
            saveError={mutation.isError ? getErrorMessage(mutation.error) : null}
            saved={saved}
          />
        ) : null}
        {profileQuery.data?.profile === null ? (
          <section className="rounded-3xl border border-dashed bg-card p-8">
            <h2 className="text-xl font-semibold">No travel preference profile exists yet</h2>
            <p className="mt-3 max-w-xl text-muted-foreground">The confirmed API Slice supports GET and PUT for existing Profiles. Creating a new Profile requires a separate confirmed contract, so no data has been fabricated or saved locally.</p>
            <Link href="/home" className="mt-6 inline-flex min-h-11 items-center rounded-xl font-semibold text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">Return to Explore</Link>
          </section>
        ) : null}
      </div>
    </main>
  );
}
