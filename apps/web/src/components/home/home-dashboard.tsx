"use client";

import { Heart, MapPinned, Settings2 } from "lucide-react";
import Link from "next/link";

import { useMyProfile, useTrips } from "@/lib/query/hooks";
import { useDataMode } from "@/lib/query/provider";
import { DemoDataBadge, ErrorState, LoadingState } from "@/components/ui/data-state";
import { TripList } from "./trip-list";

export function HomeDashboard() {
  const mode = useDataMode();
  const profileQuery = useMyProfile();
  const tripsQuery = useTrips();

  return (
    <main className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 md:px-[clamp(2rem,4vw,3.5rem)] md:py-[42px]">
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.11em] text-primary">Your private travel space</p>
          <h1 className="mt-2 text-[clamp(2.25rem,5vw,3rem)] font-bold leading-none tracking-[-0.055em]">My program</h1>
          <p className="mt-3 max-w-xl text-base text-muted-foreground">Continue a trip that is taking shape, or tune the private preferences that guide your recommendations.</p>
        </div>
        {mode === "fixture" ? <DemoDataBadge /> : null}
      </header>

      <section className="my-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.45fr_1fr_1fr]" aria-label="Workspace summary">
        <article className="flex min-h-[116px] items-center gap-4 rounded-[22px] border border-[#a4ddd2] bg-[linear-gradient(110deg,#effbf7,var(--card))] p-[18px] shadow-[0_8px_24px_#102a4308] sm:col-span-2 lg:col-span-1">
          <span className="relative grid size-[55px] shrink-0 place-items-center rounded-[18px] bg-[#ef7654] text-xl font-black text-white shadow-[inset_0_-7px_#d85544]" aria-hidden="true">W.</span>
          <div>
            <p className="text-[13px] text-muted-foreground">Your travel space is ready</p>
            <strong className="mt-0.5 block text-lg tracking-[-0.04em]">Preferences and trips stay private</strong>
          </div>
        </article>
        <SummaryCard label="Trips" value={tripsQuery.data ? String(tripsQuery.data.trips.length) : "—"} detail="Available in your workspace" />
        <SummaryCard label="Profile" value={profileQuery.data?.profile ? "Ready" : profileQuery.data ? "Not set" : "—"} detail="Private by default" />
      </section>

      <section aria-labelledby="profile-heading">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.11em] text-primary">Private by default</p>
            <h2 id="profile-heading" className="mt-1 text-xl font-bold tracking-[-0.035em]">Profile snapshot</h2>
          </div>
          <Link href="/profile" className="inline-flex min-h-11 items-center gap-2 rounded-[14px] px-3 text-sm font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"><Settings2 aria-hidden="true" className="size-4" /> Edit profile</Link>
        </div>
        {profileQuery.isPending ? <LoadingState label="Loading your private profile" /> : null}
        {profileQuery.isError ? <ErrorState error={profileQuery.error} title="Profile unavailable" /> : null}
        {profileQuery.data?.profile ? (
          <div className="grid gap-px overflow-hidden rounded-[22px] border bg-border shadow-[0_8px_24px_#102a4308] sm:grid-cols-3">
            <SummaryItem icon={MapPinned} label="Departure" value={profileQuery.data.profile.departureCity ?? "Not set"} />
            <SummaryItem icon={Heart} label="Interests" value={profileQuery.data.profile.interests?.join(", ") || "Not set"} />
            <SummaryItem icon={Settings2} label="Stay style" value={profileQuery.data.profile.accommodationStyle?.replace("_", " ") ?? "Not set"} />
          </div>
        ) : null}
        {profileQuery.data?.profile === null ? (
          <div className="rounded-[22px] border border-dashed bg-card p-7">
            <h3 className="font-bold">No Profile found</h3>
            <p className="mt-2 text-sm text-muted-foreground">Profile creation is not exposed by the confirmed GET/PUT slice yet.</p>
            <Link href="/profile" className="mt-4 inline-flex min-h-11 items-center font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">Review Profile setup</Link>
          </div>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="trips-heading">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 id="trips-heading" className="text-xl font-bold tracking-[-0.035em]">Your trips</h2>
          {tripsQuery.data ? <span className="text-[13px] font-bold text-muted-foreground">Showing {tripsQuery.data.trips.length}</span> : null}
        </div>
        {tripsQuery.isPending ? <LoadingState label="Loading your trips" /> : null}
        {tripsQuery.isError ? <ErrorState error={tripsQuery.error} title="Trips unavailable" /> : null}
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
