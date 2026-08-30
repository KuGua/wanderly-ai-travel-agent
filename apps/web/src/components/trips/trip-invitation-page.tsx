"use client";

import {
  ArrowLeft,
  Check,
  Clock3,
  Copy,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Mail,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link } from "@/i18n/navigation";
import { useCreateTripInvitation, useTrip } from "@/lib/query/hooks";

const INVITATION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export function TripInvitationPage({ tripId }: { tripId: string }) {
  const t = useTranslations("trips.workspace.invitation");
  const tWorkspace = useTranslations("trips.workspace");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const tripQuery = useTrip(tripId);
  const create = useCreateTripInvitation(tripId);
  const [email, setEmail] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (tripQuery.isPending) {
    return (
      <main className="mx-auto w-full max-w-[1180px] px-5 py-8">
        <LoadingState label={tCommon("loadingTrips")} />
      </main>
    );
  }

  if (tripQuery.isError || !tripQuery.data) {
    return (
      <main className="mx-auto w-full max-w-[1180px] px-5 py-8">
        <ErrorState error={tripQuery.error} title={t("unavailableTitle")} />
      </main>
    );
  }

  const { trip, members, callerRole } = tripQuery.data;

  async function createInvitation() {
    if (!email.trim() || create.isPending) return;

    try {
      const result = await create.mutateAsync({
        recipientEmail: email.trim(),
        expiresAt: new Date(Date.now() + INVITATION_DURATION_MS).toISOString(),
      });
      setInviteLink(`${window.location.origin}/${locale}/trips/join/${result.inviteToken}`);
    } catch {
      // The mutation renders its safe error state below.
    }
  }

  async function copyLink() {
    if (!inviteLink) return;

    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (callerRole !== "CREATOR") {
    return (
      <main className="mx-auto w-full max-w-[720px] px-5 py-8">
        <section role="alert" className="bg-card p-6 text-center wanderly-edge wanderly-r-lg wanderly-shadow">
          <h1 className="text-xl font-bold">{t("creatorOnlyTitle")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("creatorOnlyBody")}</p>
          <Link href={`/trips/${tripId}`} className="mt-5 inline-flex min-h-11 items-center gap-2 px-3 font-bold wanderly-underline">
            <ArrowLeft aria-hidden="true" className="size-4" />
            {t("back")}
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 md:py-8">
      <Link href={`/trips/${tripId}`} className="inline-flex min-h-11 items-center gap-2 text-sm font-bold text-muted-foreground wanderly-underline">
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("back")}
      </Link>

      <article className="mt-2 overflow-hidden bg-card wanderly-edge wanderly-r-lg wanderly-shadow">
        <header className="flex flex-col gap-4 border-b-2 border-[var(--w-ink)] bg-[var(--w-fog)] px-5 py-5 sm:flex-row sm:items-center sm:justify-between md:px-7">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center bg-[var(--w-highlight)] wanderly-edge wanderly-r-md wanderly-shadow-sm">
              <UserPlus aria-hidden="true" className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-black uppercase tracking-[.12em] wanderly-underline">{t("eyebrow")}</p>
              <h1 className="mt-1 text-2xl font-bold tracking-[-.045em] sm:text-3xl">{t("title")}</h1>
              <p className="mt-1 max-w-[720px] text-sm leading-6 text-muted-foreground">{t("pageBody", { trip: trip.name })}</p>
            </div>
          </div>
          <span className="inline-flex min-h-9 shrink-0 items-center gap-2 self-start bg-card px-3 text-xs font-extrabold wanderly-edge-thin wanderly-r-sm sm:self-center">
            <LockKeyhole aria-hidden="true" className="size-4" />
            {t("privateLink")}
          </span>
        </header>

        <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.55fr)_minmax(280px,.8fr)]">
          <section className="min-w-0 p-5 md:p-7 lg:border-r-2 lg:border-[var(--w-ink)]" aria-labelledby="invite-email-heading">
            {inviteLink ? (
              <div aria-live="polite">
                <div className="flex items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center bg-[var(--w-highlight)] wanderly-edge wanderly-r-sm">
                    <Check aria-hidden="true" className="size-5" />
                  </span>
                  <div>
                    <h2 id="invite-email-heading" className="text-xl font-bold">{t("emailCreatedTitle", { email })}</h2>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("emailCreatedBody")}</p>
                  </div>
                </div>
                <label className="mt-5 block text-xs font-bold" htmlFor="invite-link">{t("linkLabel")}</label>
                <div className="mt-1 flex flex-col gap-3 sm:flex-row">
                  <input id="invite-link" readOnly value={inviteLink} className="min-h-12 min-w-0 flex-1 rounded-[9px] border-2 border-[var(--w-line)] bg-background px-3 text-sm" />
                  <button type="button" onClick={() => void copyLink()} className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 px-5 text-sm font-extrabold wanderly-edge wanderly-r-sm wanderly-shadow-sm wanderly-press wanderly-action">
                    <Copy aria-hidden="true" className="size-4" />
                    {copied ? t("copied") : t("copy")}
                  </button>
                </div>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("emailDeliveryNotice")}</p>
              </div>
            ) : (
              <>
                <h2 id="invite-email-heading" className="text-xl font-bold">{t("emailLabel")}</h2>
                <p className="mt-1 max-w-[680px] text-sm leading-6 text-muted-foreground">{t("emailBody")}</p>
                <label className="mt-5 block text-xs font-bold" htmlFor="recipient-email">{t("emailLabel")}</label>
                <div className="mt-1 flex flex-col gap-3 sm:flex-row">
                  <div className="relative min-w-0 flex-1">
                    <Mail aria-hidden="true" className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      id="recipient-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder={t("emailPlaceholder")}
                      className="min-h-12 w-full rounded-[9px] border-2 border-[var(--w-line)] bg-background py-2 pl-10 pr-3 text-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"
                    />
                  </div>
                  <button type="button" onClick={() => void createInvitation()} disabled={!email.trim() || create.isPending} className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 px-5 text-sm font-extrabold wanderly-edge wanderly-r-sm wanderly-shadow-sm wanderly-press wanderly-action disabled:opacity-50">
                    {create.isPending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <UserPlus aria-hidden="true" className="size-4" />}
                    {create.isPending ? t("creating") : t("emailCreate")}
                  </button>
                </div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{t("emailHint")}</p>
                {create.isError ? <p role="alert" className="mt-3 text-xs text-destructive">{t("createError")}</p> : null}
              </>
            )}

            <div className="mt-6 grid overflow-hidden bg-[var(--w-line)] sm:grid-cols-3 wanderly-edge-thin wanderly-r-md">
              <InvitationNote icon={Link2} label={t("emailBoundTitle")} body={t("emailBoundBody")} />
              <InvitationNote icon={Clock3} label={t("expiresTitle")} body={t("expiresBody")} />
              <InvitationNote icon={LockKeyhole} label={t("privacyTitle")} body={t("privacyBody")} />
            </div>
          </section>

          <aside className="min-w-0 bg-[var(--w-fog)] p-5 md:p-7" aria-labelledby="current-members-heading">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <UsersRound aria-hidden="true" className="size-5" />
                  <h2 id="current-members-heading" className="text-lg font-bold">{t("currentMembers")}</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{t("memberCount", { count: members.length })}</p>
              </div>
              <span className="grid size-9 place-items-center bg-[var(--w-highlight)] text-sm font-black wanderly-edge-thin wanderly-r-sm">{members.length}</span>
            </div>

            <ul className="mt-4 space-y-2">
              {members.map((member) => (
                <li key={member.userId} className="flex min-h-14 items-center gap-3 bg-card px-3 py-2 text-sm wanderly-edge-thin wanderly-r-sm">
                  <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center bg-[var(--w-mist)] font-black uppercase wanderly-edge-thin wanderly-r-sm">
                    {member.displayName.trim().charAt(0) || "?"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-bold">{member.displayName}</span>
                  <span className="shrink-0 bg-[var(--w-fog)] px-2 py-1 text-[11px] font-extrabold text-muted-foreground wanderly-edge-thin wanderly-r-xs">
                    {tWorkspace(`roleValue.${member.role}` as "roleValue.CREATOR" | "roleValue.MEMBER")}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t-2 border-dashed border-[var(--w-line)] pt-4 text-xs leading-5 text-muted-foreground">{t("memberNotice")}</p>
          </aside>
        </div>
      </article>
    </main>
  );
}

function InvitationNote({ icon: Icon, label, body }: { icon: typeof Link2; label: string; body: string }) {
  return (
    <div className="min-w-0 bg-[var(--w-mist)] p-3.5 sm:min-h-28">
      <Icon aria-hidden="true" className="size-4" />
      <p className="mt-2 text-xs font-black">{label}</p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{body}</p>
    </div>
  );
}
