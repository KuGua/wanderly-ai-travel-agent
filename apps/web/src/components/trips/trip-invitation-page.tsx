"use client";

import { ArrowLeft, Check, Copy, LoaderCircle, Search, UserPlus, UsersRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { Link } from "@/i18n/navigation";
import { useCreateTripInvitation, useSearchTripInvitees, useTrip } from "@/lib/query/hooks";

const INVITATION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export function TripInvitationPage({ tripId }: { tripId: string }) {
  const t = useTranslations("trips.workspace.invitation");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const tripQuery = useTrip(tripId);
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<{ id: string; displayName: string } | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const search = useSearchTripInvitees(tripId, query, tripQuery.data?.callerRole === "CREATOR" && !inviteLink);
  const create = useCreateTripInvitation(tripId);

  if (tripQuery.isPending) return <main className="mx-auto w-full max-w-[960px] px-5 py-8 sm:px-8"><LoadingState label={tCommon("loadingTrips")} /></main>;
  if (tripQuery.isError || !tripQuery.data) return <main className="mx-auto w-full max-w-[960px] px-5 py-8 sm:px-8"><ErrorState error={tripQuery.error} title={t("unavailableTitle")} /></main>;

  const { trip, members, callerRole } = tripQuery.data;
  if (callerRole !== "CREATOR") {
    return <main className="mx-auto w-full max-w-[720px] px-5 py-8 sm:px-8"><section role="alert" className="bg-card p-6 text-center wanderly-edge wanderly-r-lg wanderly-shadow"><h1 className="text-xl font-bold">{t("creatorOnlyTitle")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("creatorOnlyBody")}</p><Link href={`/trips/${tripId}`} className="mt-5 inline-flex min-h-11 items-center gap-2 px-3 font-bold wanderly-underline"><ArrowLeft aria-hidden="true" className="size-4" />{t("back")}</Link></section></main>;
  }

  async function createInvitation() {
    if (!selectedUser || create.isPending) return;
    try {
      const result = await create.mutateAsync({ invitedUserId: selectedUser.id, expiresAt: new Date(Date.now() + INVITATION_DURATION_MS).toISOString() });
      setInviteLink(`${window.location.origin}/${locale}/trips/join/${result.inviteToken}`);
    } catch {
      // Render a safe recovery message without revealing account or token details.
    }
  }

  async function copyLink() {
    if (!inviteLink) return;
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); } catch { setCopied(false); }
  }

  return <main className="mx-auto w-full max-w-[960px] px-5 py-8 sm:px-8 md:py-12">
    <Link href={`/trips/${tripId}`} className="inline-flex min-h-11 items-center gap-2 text-sm font-bold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"><ArrowLeft aria-hidden="true" className="size-4" />{t("back")}</Link>
    <header className="mt-4 bg-[var(--w-fog)] px-6 py-6 wanderly-edge wanderly-r-lg wanderly-shadow sm:px-8">
      <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.1em] wanderly-underline"><UserPlus aria-hidden="true" className="size-4" /> {t("eyebrow")}</p>
      <h1 className="mt-3 text-[clamp(2rem,5vw,2.75rem)] font-bold leading-none tracking-[-0.055em]">{t("title")}</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{t("pageBody", { trip: trip.name })}</p>
    </header>
    <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(240px,0.65fr)]">
      <section className="bg-card p-5 wanderly-edge wanderly-r-lg wanderly-shadow sm:p-6">
        {inviteLink ? <div aria-live="polite"><span className="grid size-11 place-items-center bg-[var(--w-highlight)] wanderly-edge wanderly-r-sm"><Check aria-hidden="true" className="size-5" /></span><h2 className="mt-4 text-xl font-bold">{t("createdTitle", { name: selectedUser?.displayName ?? "" })}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{t("createdBody")}</p><label className="mt-5 block text-xs font-bold" htmlFor="invite-link">{t("linkLabel")}</label><input id="invite-link" readOnly value={inviteLink} className="mt-1 min-h-11 w-full rounded-[9px] border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30" /><button type="button" onClick={() => void copyLink()} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 px-4 text-sm font-extrabold wanderly-edge wanderly-r-sm wanderly-shadow-sm wanderly-press wanderly-action focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"><Copy aria-hidden="true" className="size-4" />{copied ? t("copied") : t("copy")}</button><p className="mt-3 text-xs leading-5 text-muted-foreground">{t("oneTimeNotice")}</p></div> : <><h2 className="text-lg font-bold">{t("searchLabel")}</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">{t("body")}</p><label className="mt-5 block text-xs font-bold" htmlFor="invitee-search">{t("searchLabel")}</label><div className="relative mt-1"><Search aria-hidden="true" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input id="invitee-search" autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setSelectedUser(null); }} placeholder={t("searchPlaceholder")} className="min-h-11 w-full rounded-[9px] border bg-background py-2 pl-10 pr-3 text-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30" /></div><div className="mt-2 min-h-20" aria-live="polite">{query.trim().length < 2 ? <p className="text-xs text-muted-foreground">{t("searchHint")}</p> : null}{search.isPending ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t("searching")}</p> : null}{search.isError ? <p role="alert" className="text-xs text-destructive">{t("searchError")}</p> : null}{search.data && search.data.candidates.length === 0 ? <p className="text-xs text-muted-foreground">{t("noResults")}</p> : null}{search.data?.candidates.map((candidate) => <button key={candidate.id} type="button" aria-pressed={selectedUser?.id === candidate.id} onClick={() => setSelectedUser(candidate)} className={`mt-1 flex min-h-11 w-full items-center justify-between px-3 text-left text-sm font-bold wanderly-edge-thin wanderly-r-sm wanderly-press focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 ${selectedUser?.id === candidate.id ? "bg-[var(--w-highlight)]" : "bg-[var(--w-mist)]"}`}><span>{candidate.displayName}</span><span className="text-xs font-normal">{selectedUser?.id === candidate.id ? t("selected") : ""}</span></button>)}</div>{create.isError ? <p role="alert" className="mt-3 text-xs text-destructive">{t("createError")}</p> : null}<button type="button" onClick={() => void createInvitation()} disabled={!selectedUser || create.isPending} className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 px-4 text-sm font-extrabold wanderly-edge wanderly-r-sm wanderly-shadow-sm wanderly-press wanderly-action focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50">{create.isPending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <UserPlus aria-hidden="true" className="size-4" />}{create.isPending ? t("creating") : t("create")}</button></>}</section>
      <aside className="bg-card p-5 wanderly-edge wanderly-r-lg wanderly-shadow sm:p-6"><div className="flex items-center gap-2"><UsersRound aria-hidden="true" className="size-5" /><h2 className="font-bold">{t("currentMembers")}</h2></div><p className="mt-1 text-sm text-muted-foreground">{t("memberCount", { count: members.length })}</p><ul role="list" className="mt-4 divide-y-2 divide-[var(--w-line)] border-y-2 border-[var(--w-line)]">{members.map((member) => <li key={member.userId} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm"><span className="min-w-0 truncate font-bold">{member.displayName}</span><span className="shrink-0 text-xs text-muted-foreground">{t(`roleValue.${member.role}` as "roleValue.CREATOR" | "roleValue.MEMBER")}</span></li>)}</ul><p className="mt-4 text-xs leading-5 text-muted-foreground">{t("memberNotice")}</p></aside>
    </div>
  </main>;
}
