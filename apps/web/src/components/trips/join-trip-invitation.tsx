"use client";

import { ArrowRight, CalendarDays, Check, LoaderCircle, LockKeyhole, MapPinned, ShieldCheck, UserRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth/auth-provider";
import { useAcceptInvitation, useDeclineInvitation, useInvitationPreview } from "@/lib/query/hooks";

export function JoinTripInvitation({ inviteToken }: { inviteToken: string }) {
  const t = useTranslations("invitation");
  const fmt = useFormatter();
  const router = useRouter();
  const auth = useAuth();
  const isCheckingIdentity = auth.status === "CHECKING";
  const isSignedIn = auth.status === "SIGNED_IN" || auth.status === "LOCAL_DEV";
  const preview = useInvitationPreview(isSignedIn ? inviteToken : null);
  const accept = useAcceptInvitation();
  const decline = useDeclineInvitation();
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [acceptedTripId, setAcceptedTripId] = useState<string | null>(null);

  async function acceptInvitation() {
    try {
      const result = await accept.mutateAsync(inviteToken);
      setAcceptedTripId(result.tripId);
    } catch {
      // The mutation state renders a recovery action without exposing server details.
    }
  }

  async function declineInvitation() {
    try {
      await decline.mutateAsync(inviteToken);
      setConfirmDecline(false);
    } catch {
      // Preserve the confirmation surface so the user can retry safely.
    }
  }

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-[760px] items-center px-5 py-8 sm:px-8">
      <section className="w-full overflow-hidden bg-card wanderly-edge wanderly-r-lg wanderly-shadow-lg">
        <header className="border-b-2 border-[var(--w-ink)] bg-[var(--w-fog)] px-6 py-6 sm:px-8">
          <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.11em] wanderly-underline">
            <ShieldCheck aria-hidden="true" className="size-4" /> {t("kicker")}
          </p>
          <h1 className="mt-3 text-[clamp(2rem,6vw,2.75rem)] font-bold leading-none tracking-[-0.055em]">
            {t("title")}
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">{t("subtitle")}</p>
        </header>

        <div className="p-6 sm:p-8">
          {isCheckingIdentity ? <PendingState label={t("checkingIdentity")} /> : null}
          {!isCheckingIdentity && !isSignedIn ? (
            <section className="text-center" aria-labelledby="sign-in-heading">
              <span className="mx-auto grid size-12 place-items-center bg-[var(--w-info)] wanderly-edge wanderly-r-md wanderly-shadow-sm">
                <LockKeyhole aria-hidden="true" className="size-5" />
              </span>
              <h2 id="sign-in-heading" className="mt-4 text-xl font-bold tracking-[-0.035em]">{t("signInTitle")}</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t("signInBody")}</p>
              <Link href="/login" className="mt-6 inline-flex min-h-11 items-center gap-2 px-5 text-sm font-extrabold wanderly-edge wanderly-r-md wanderly-shadow wanderly-press wanderly-action">
                {t("signInAction")} <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
              <p className="mt-4 text-sm text-muted-foreground">{t("registerPrompt")} <Link href="/register" className="font-bold underline underline-offset-4">{t("registerAction")}</Link></p>
            </section>
          ) : null}

          {isSignedIn && preview.isPending ? <PendingState label={t("loading")} /> : null}
          {isSignedIn && preview.isError ? (
            <section className="text-center" role="status">
              <span className="mx-auto grid size-12 place-items-center bg-[var(--w-fog)] wanderly-edge wanderly-r-md">
                <LockKeyhole aria-hidden="true" className="size-5" />
              </span>
              <h2 className="mt-4 text-xl font-bold tracking-[-0.035em]">{t("unavailableTitle")}</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t("unavailableBody")}</p>
              <Link href="/home" className="mt-6 inline-flex min-h-11 items-center font-extrabold wanderly-underline">{t("returnHome")}</Link>
            </section>
          ) : null}

          {isSignedIn && preview.data && !acceptedTripId && !decline.isSuccess ? (
            <div>
              <section aria-labelledby="trip-summary-heading">
                <p className="text-[11px] font-black uppercase tracking-[0.11em] text-muted-foreground">{t("tripLabel")}</p>
                <h2 id="trip-summary-heading" className="mt-1 text-2xl font-bold tracking-[-0.045em]">{preview.data.trip.name}</h2>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <SummaryItem icon={MapPinned} label={t("destinations")} value={preview.data.trip.destinationCandidates.join(" · ") || t("destinationsUnknown")} />
                  <SummaryItem
                    icon={CalendarDays}
                    label={t("dates")}
                    value={preview.data.trip.travelDateStart && preview.data.trip.travelDateEnd
                      ? fmt.dateTime(new Date(preview.data.trip.travelDateStart), { dateStyle: "medium" }) + " – " + fmt.dateTime(new Date(preview.data.trip.travelDateEnd), { dateStyle: "medium" })
                      : t("datesUnknown")}
                  />
                </div>
              </section>

              {preview.data.trip.status === "DRAFT" ? (
                <section className="mt-6 bg-[var(--w-fog)] p-4 wanderly-edge-thin wanderly-r-sm" aria-labelledby="draft-heading">
                  <div className="flex items-start gap-3">
                    <LockKeyhole aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                    <div>
                      <h2 id="draft-heading" className="font-bold">{t("draftTitle")}</h2>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("draftBody")}</p>
                    </div>
                  </div>
                </section>
              ) : null}

              <section className="mt-6 bg-[var(--w-mist)] p-4 wanderly-edge-thin wanderly-r-sm" aria-labelledby="membership-heading">
                <div className="flex items-start gap-3">
                  <UserRound aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                  <div>
                    <h2 id="membership-heading" className="font-bold">{t("membershipTitle")}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("membershipBody")}</p>
                  </div>
                </div>
              </section>

              <section className="mt-4 border-2 border-dashed border-[var(--w-ink)] p-4 wanderly-r-sm" aria-labelledby="privacy-heading">
                <div className="flex items-start gap-3">
                  <LockKeyhole aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
                  <div>
                    <h2 id="privacy-heading" className="font-bold">{t("privacyTitle")}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("privacyBody")}</p>
                  </div>
                </div>
              </section>

              <p className="mt-4 text-xs text-muted-foreground">{t("expiry", { date: fmt.dateTime(new Date(preview.data.expiresAt), { dateStyle: "medium", timeStyle: "short" }) })}</p>
              {accept.isError || decline.isError ? <p role="alert" className="mt-3 text-sm text-destructive">{t("actionError")}</p> : null}

              {!confirmDecline ? (
                <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <button type="button" onClick={() => setConfirmDecline(true)} disabled={accept.isPending || decline.isPending} className="min-h-11 px-2 text-sm font-bold text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:opacity-50">
                    {t("decline")}
                  </button>
                  <button type="button" onClick={acceptInvitation} disabled={accept.isPending || decline.isPending} className="inline-flex min-h-12 items-center justify-center gap-2 px-5 text-sm font-extrabold wanderly-edge wanderly-r-md wanderly-shadow wanderly-press wanderly-action disabled:cursor-not-allowed disabled:opacity-60">
                    {accept.isPending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : null}
                    {accept.isPending ? t("accepting") : t("accept")}
                  </button>
                </div>
              ) : (
                <div className="mt-6 bg-[var(--w-fog)] p-4 wanderly-edge-thin wanderly-r-sm" role="alert">
                  <p className="text-sm font-bold">{t("declineConfirmTitle")}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t("declineConfirmBody")}</p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button type="button" onClick={declineInvitation} disabled={decline.isPending} className="inline-flex min-h-11 items-center gap-2 bg-card px-4 text-sm font-extrabold wanderly-edge wanderly-r-sm wanderly-press disabled:opacity-60">
                      {decline.isPending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : null}
                      {t("declineConfirmAction")}
                    </button>
                    <button type="button" onClick={() => setConfirmDecline(false)} disabled={decline.isPending} className="min-h-11 px-3 text-sm font-bold underline underline-offset-4 disabled:opacity-60">{t("cancel")}</button>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {acceptedTripId ? (
            <section className="text-center" aria-labelledby="accepted-heading">
              <span className="mx-auto grid size-12 place-items-center bg-[var(--w-highlight)] wanderly-edge wanderly-r-md wanderly-shadow-sm"><Check aria-hidden="true" className="size-6" /></span>
              <h2 id="accepted-heading" className="mt-4 text-xl font-bold tracking-[-0.035em]">{t("acceptedTitle")}</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t("acceptedBody")}</p>
              <button type="button" onClick={() => router.push(`/trips/${acceptedTripId}` as "/trips/[tripId]")} className="mt-6 inline-flex min-h-12 items-center gap-2 px-5 text-sm font-extrabold wanderly-edge wanderly-r-md wanderly-shadow wanderly-press wanderly-action">
                {t("setSharingScope")} <ArrowRight aria-hidden="true" className="size-4" />
              </button>
            </section>
          ) : null}

          {decline.isSuccess ? <section className="text-center" role="status"><h2 className="text-xl font-bold tracking-[-0.035em]">{t("declinedTitle")}</h2><p className="mt-2 text-sm text-muted-foreground">{t("declinedBody")}</p><Link href="/home" className="mt-6 inline-flex min-h-11 items-center font-extrabold wanderly-underline">{t("returnHome")}</Link></section> : null}
        </div>
      </section>
    </main>
  );
}

function PendingState({ label }: { label: string }) {
  return <div className="flex min-h-44 items-center justify-center gap-3 text-sm text-muted-foreground" aria-busy="true" aria-live="polite"><LoaderCircle aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />{label}</div>;
}

function SummaryItem({ icon: Icon, label, value }: { icon: typeof MapPinned; label: string; value: string }) {
  return <div className="min-h-24 bg-[var(--w-fog)] p-3.5 wanderly-edge-thin wanderly-r-sm"><Icon aria-hidden="true" className="size-4" /><p className="mt-2 text-[11px] font-black uppercase tracking-[0.1em] text-muted-foreground">{label}</p><p className="mt-1 text-sm font-bold">{value}</p></div>;
}
