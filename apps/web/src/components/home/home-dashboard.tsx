"use client";

import { Heart, MapPinned, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link } from "@/i18n/navigation";
import { useMyProfile, useTrips } from "@/lib/query/hooks";

import { TripList } from "./trip-list";

export function HomeDashboard() {
  const tHome = useTranslations("home");
  const tCommon = useTranslations("common");
  const profileQuery = useMyProfile();
  const tripsQuery = useTrips();

  return (
    <main className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 md:px-[clamp(2rem,4vw,3.5rem)] md:py-[42px]">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.11em] text-primary">{tHome("kicker")}</p>
          <h1 className="mt-2 text-[clamp(2.25rem,5vw,3rem)] font-bold leading-none tracking-[-0.055em]">{tHome("title")}</h1>
          <p className="mt-3 max-w-xl text-base text-muted-foreground">{tHome("subtitle")}</p>
        </div>
      </header>

      <section className="my-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.45fr_1fr_1fr]" aria-label={tHome("summary.ariaLabel")}>
        <article className="flex min-h-[116px] items-center gap-4 rounded-[22px] border border-[#a4ddd2] bg-[linear-gradient(110deg,#effbf7,var(--card))] p-[18px] shadow-[0_8px_24px_#102a4308] sm:col-span-2 lg:col-span-1">
          <span className="relative grid size-[55px] shrink-0 place-items-center rounded-[18px] bg-[#ef7654] text-xl font-black text-white shadow-[inset_0_-7px_#d85544]" aria-hidden="true">{tCommon("brandGlyph")}</span>
          <div>
            <p className="text-[13px] text-muted-foreground">{tHome("summary.ready")}</p>
            <strong className="mt-0.5 block text-lg tracking-[-0.04em]">{tHome("summary.privacyHeadline")}</strong>
          </div>
        </article>
        <SummaryCard label={tHome("summary.tripsLabel")} value={tripsQuery.data ? String(tripsQuery.data.trips.length) : "—"} detail={tHome("summary.tripsDetail")} />
        <SummaryCard label={tHome("summary.profileLabel")} value={profileQuery.data?.profile ? tHome("summary.profileReady") : profileQuery.data ? tHome("summary.profileNotSet") : "—"} detail={tHome("summary.profileDetail")} />
      </section>

      <section aria-labelledby="profile-heading">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.11em] text-primary">{tHome("profile.kicker")}</p>
            <h2 id="profile-heading" className="mt-1 text-xl font-bold tracking-[-0.035em]">{tHome("profile.heading")}</h2>
          </div>
          <Link href="/profile" className="inline-flex min-h-11 items-center gap-2 rounded-[14px] px-3 text-sm font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
            <Settings2 aria-hidden="true" className="size-4" /> {tHome("profile.edit")}
          </Link>
        </div>
        {profileQuery.isPending ? <LoadingState label={tCommon("loadingProfile")} /> : null}
        {profileQuery.isError ? <ErrorState error={profileQuery.error} title={tHome("errorStateProfileUnavailable")} /> : null}
        {profileQuery.data?.profile ? (
          <div className="grid gap-px overflow-hidden rounded-[22px] border bg-border shadow-[0_8px_24px_#102a4308] sm:grid-cols-3">
            <SummaryItem icon={MapPinned} label={tHome("profile.departure")} value={profileQuery.data.profile.departureCity ?? tHome("summary.notSet")} />
            <SummaryItem icon={Heart} label={tHome("profile.interests")} value={profileQuery.data.profile.interests?.length ? profileQuery.data.profile.interests.join(", ") : tHome("summary.notSet")} />
            <SummaryItem icon={Settings2} label={tHome("profile.stayStyle")} value={profileQuery.data.profile.accommodationStyle ? tHome(`trip.accommodation.${profileQuery.data.profile.accommodationStyle}`) : tHome("summary.notSet")} />
          </div>
        ) : null}
        {profileQuery.data?.profile === null ? (
          <div className="rounded-[22px] border border-dashed bg-card p-7">
            <h3 className="font-bold">{tHome("profile.emptyTitle")}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{tHome("profile.emptyBody")}</p>
            <Link href="/profile" className="mt-4 inline-flex min-h-11 items-center font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
              {tHome("profile.emptyAction")}
            </Link>
          </div>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="trips-heading">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 id="trips-heading" className="text-xl font-bold tracking-[-0.035em]">{tHome("trips.heading")}</h2>
          {tripsQuery.data ? <span className="text-[13px] font-bold text-muted-foreground">{tHome("trips.showing", { count: tripsQuery.data.trips.length })}</span> : null}
        </div>
        {tripsQuery.isPending ? <LoadingState label={tCommon("loadingTrips")} /> : null}
        {tripsQuery.isError ? <ErrorState error={tripsQuery.error} title={tHome("errorStateTripsUnavailable")} /> : null}
        {tripsQuery.data ? <TripList trips={tripsQuery.data.trips} /> : null}
      </section>
    </main>
  );
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="min-h-[116px] rounded-[22px] border bg-card p-[18px] shadow-[0_8px_24px_#102a4308]">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <strong className="mt-0.5 block text-2xl tracking-[-0.04em]">{value}</strong>
      <p className="mt-1 text-[13px] text-muted-foreground">{detail}</p>
    </article>
  );
}

function SummaryItem({ icon: Icon, label, value }: { icon: typeof Heart; label: string; value: string }) {
  return (
    <div className="bg-card p-5">
      <Icon aria-hidden="true" className="mb-3 size-5 text-primary" />
      <p className="text-[11px] font-black uppercase tracking-[0.11em] text-muted-foreground">{label}</p>
      <p className="mt-1 capitalize">{value}</p>
    </div>
  );
}
