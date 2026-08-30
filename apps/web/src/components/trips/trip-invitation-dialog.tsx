"use client";

import { Check, Copy, LoaderCircle, Search, UserPlus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

import { useCreateTripInvitation, useSearchTripInvitees } from "@/lib/query/hooks";

const INVITATION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;

export function TripInvitationDialog({ tripId, locale, onClose }: { tripId: string; locale: string; onClose: () => void }) {
  const t = useTranslations("trips.workspace.invitation");
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState<{ id: string; displayName: string } | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const search = useSearchTripInvitees(tripId, query, !inviteLink);
  const create = useCreateTripInvitation(tripId);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !create.isPending) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [create.isPending, onClose]);

  async function createInvitation() {
    if (!selectedUser || create.isPending) return;
    try {
      const result = await create.mutateAsync({
        invitedUserId: selectedUser.id,
        expiresAt: new Date(Date.now() + INVITATION_DURATION_MS).toISOString(),
      });
      setInviteLink(`${window.location.origin}/${locale}/trips/join/${result.inviteToken}`);
    } catch {
      // The mutation error is deliberately presented without account or token details.
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#102a4366] p-4" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md bg-card wanderly-edge wanderly-r-lg wanderly-shadow-lg" onMouseDown={(event) => event.stopPropagation()}>
        <header className="flex items-start justify-between gap-4 border-b-2 border-[var(--w-ink)] bg-[var(--w-fog)] px-5 py-4">
          <div>
            <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.1em] wanderly-underline"><UserPlus aria-hidden="true" className="size-4" /> {t("eyebrow")}</p>
            <h2 id={titleId} className="mt-2 text-xl font-bold tracking-[-0.035em]">{t("title")}</h2>
          </div>
          <button type="button" aria-label={t("close")} onClick={onClose} disabled={create.isPending} className="grid size-11 shrink-0 place-items-center bg-card wanderly-edge wanderly-r-sm wanderly-press focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:opacity-50"><X aria-hidden="true" className="size-4" /></button>
        </header>

        <div className="p-5">
          {inviteLink ? (
            <div aria-live="polite">
              <span className="grid size-11 place-items-center bg-[var(--w-highlight)] wanderly-edge wanderly-r-sm"><Check aria-hidden="true" className="size-5" /></span>
              <h3 className="mt-4 font-bold">{t("createdTitle", { name: selectedUser?.displayName ?? "" })}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("createdBody")}</p>
              <label className="mt-4 block text-xs font-bold" htmlFor="invite-link">{t("linkLabel")}</label>
              <input id="invite-link" readOnly value={inviteLink} className="mt-1 min-h-11 w-full rounded-[9px] border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30" />
              <button type="button" onClick={() => void copyLink()} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 px-4 text-sm font-extrabold wanderly-edge wanderly-r-sm wanderly-shadow-sm wanderly-press wanderly-action focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"><Copy aria-hidden="true" className="size-4" />{copied ? t("copied") : t("copy")}</button>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("oneTimeNotice")}</p>
            </div>
          ) : (
            <>
              <p className="text-sm leading-6 text-muted-foreground">{t("body")}</p>
              <label className="mt-4 block text-xs font-bold" htmlFor="invitee-search">{t("searchLabel")}</label>
              <div className="relative mt-1">
                <Search aria-hidden="true" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input id="invitee-search" autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setSelectedUser(null); }} placeholder={t("searchPlaceholder")} className="min-h-11 w-full rounded-[9px] border bg-background py-2 pl-10 pr-3 text-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30" />
              </div>
              <div className="mt-2 min-h-20" aria-live="polite">
                {query.trim().length < 2 ? <p className="text-xs text-muted-foreground">{t("searchHint")}</p> : null}
                {search.isPending ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t("searching")}</p> : null}
                {search.isError ? <p role="alert" className="text-xs text-destructive">{t("searchError")}</p> : null}
                {search.data && search.data.candidates.length === 0 ? <p className="text-xs text-muted-foreground">{t("noResults")}</p> : null}
                {search.data?.candidates.map((candidate) => <button key={candidate.id} type="button" aria-pressed={selectedUser?.id === candidate.id} onClick={() => setSelectedUser(candidate)} className={`mt-1 flex min-h-11 w-full items-center justify-between px-3 text-left text-sm font-bold wanderly-edge-thin wanderly-r-sm wanderly-press focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 ${selectedUser?.id === candidate.id ? "bg-[var(--w-highlight)]" : "bg-[var(--w-mist)]"}`}><span>{candidate.displayName}</span><span className="text-xs font-normal">{selectedUser?.id === candidate.id ? t("selected") : ""}</span></button>)}
              </div>
              {create.isError ? <p role="alert" className="mt-3 text-xs text-destructive">{t("createError")}</p> : null}
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" onClick={onClose} disabled={create.isPending} className="min-h-11 px-3 text-sm font-bold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:opacity-50">{t("cancel")}</button>
                <button type="button" onClick={() => void createInvitation()} disabled={!selectedUser || create.isPending} className="inline-flex min-h-11 items-center justify-center gap-2 px-4 text-sm font-extrabold wanderly-edge wanderly-r-sm wanderly-shadow-sm wanderly-press wanderly-action focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50">{create.isPending ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <UserPlus aria-hidden="true" className="size-4" />}{create.isPending ? t("creating") : t("create")}</button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
