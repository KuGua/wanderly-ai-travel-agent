"use client";

import { FlaskConical, LoaderCircle, LogIn, LogOut, TriangleAlert, UserRound, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useState } from "react";

import { useAuth } from "@/lib/auth/auth-provider";

export function AccountAuthControl() {
  const t = useTranslations("auth");
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim() || !password || auth.busy) return;
    const signedIn = await auth.signIn(username.trim(), password);
    setPassword("");
    if (signedIn) setOpen(false);
  }

  if (auth.status === "CHECKING") {
    return <span role="status" aria-label={t("checking")} className="grid size-10 place-items-center border-[1.5px] border-[var(--w-ink)] bg-[var(--w-fog)] text-[var(--w-ink)] wanderly-r-sm sm:size-11"><LoaderCircle aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" /></span>;
  }

  if (auth.status === "LOCAL_DEV") {
    return <span role="status" aria-label={t("localDevelopment")} title={t("localDevelopment")} className="grid size-10 place-items-center border-[1.5px] border-[var(--w-ink)] bg-[var(--w-highlight)] text-[var(--w-ink)] wanderly-r-sm sm:size-11"><FlaskConical aria-hidden="true" className="size-5" /></span>;
  }

  if (auth.status === "LOCAL_DEV_INVALID") {
    return <span role="status" aria-label={t("localDevelopmentInvalid")} title={t("localDevelopmentInvalid")} className="grid size-10 place-items-center border-[1.5px] border-destructive bg-destructive/10 text-destructive wanderly-r-sm sm:size-11"><TriangleAlert aria-hidden="true" className="size-5" /></span>;
  }

  if (auth.status === "SIGNED_IN") {
    return (
      <div className="relative">
        <button type="button" onClick={() => setOpen((current) => !current)} title={t("signedInAs", { username: auth.user?.username ?? t("traveler") })} aria-label={t("accountMenu")} className="grid size-10 place-items-center border-[1.5px] border-[var(--w-ink)] bg-[var(--w-fog)] text-[var(--w-ink)] wanderly-r-sm wanderly-press hover:bg-[var(--w-highlight)] sm:size-11">
          <UserRound aria-hidden="true" className="size-5" />
        </button>
        {open ? (
          <div className="absolute right-0 top-12 z-[120] w-64 bg-card p-4 text-foreground wanderly-edge wanderly-r-lg wanderly-shadow sm:bottom-0 sm:left-14 sm:right-auto sm:top-auto">
            <p className="truncate text-sm font-bold">{auth.user?.username}</p>
            <button type="button" disabled={auth.busy} onClick={() => void auth.signOut().then((signedOut) => { if (signedOut) setOpen(false); })} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-sidebar px-3 text-sm font-bold text-white disabled:opacity-50">
              <LogOut aria-hidden="true" className="size-4" />{t("signOut")}
            </button>
            {auth.error === "SIGN_OUT_FAILED" ? <p role="alert" className="mt-2 text-xs text-destructive">{t("signOutFailed")}</p> : null}
          </div>
        ) : null}
      </div>
    );
  }

  const unavailable = auth.status === "UNCONFIGURED";
  return (
    <div className="relative">
      <button type="button" disabled={unavailable} onClick={() => setOpen(true)} title={unavailable ? t("unconfigured") : t("signIn")} aria-label={unavailable ? t("unconfigured") : t("signIn")} className="grid size-11 place-items-center rounded-full border-2 border-[#9ce0d4] bg-[#0b5264] text-sidebar-foreground disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar-ring/50">
        <LogIn aria-hidden="true" className="size-5" />
      </button>
      {open ? (
        <div role="dialog" aria-label={t("dialogAria")} className="fixed inset-0 z-[120] grid place-items-center bg-sidebar/40 p-4">
          <form onSubmit={submit} className="relative w-full max-w-sm rounded-3xl bg-white p-6 text-foreground shadow-2xl">
            <button type="button" onClick={() => setOpen(false)} aria-label={t("close")} className="absolute right-4 top-4 grid size-10 place-items-center rounded-full bg-muted"><X aria-hidden="true" className="size-4" /></button>
            <h2 className="pr-10 text-xl font-black">{t("heading")}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t("body")}</p>
            <label className="mt-5 block text-sm font-bold">{t("username")}
              <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-border px-3 font-normal" />
            </label>
            <label className="mt-3 block text-sm font-bold">{t("password")}
              <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-border px-3 font-normal" />
            </label>
            {auth.error === "SIGN_IN_FAILED" ? <p role="alert" className="mt-3 text-sm text-destructive">{t("signInFailed")}</p> : null}
            {auth.error === "CHALLENGE_REQUIRED" ? <p role="alert" className="mt-3 text-sm text-destructive">{t("challengeRequired")}</p> : null}
            <button type="submit" disabled={auth.busy || !username.trim() || !password} className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-sidebar px-4 font-bold text-white disabled:opacity-50">
              {auth.busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <LogIn aria-hidden="true" className="size-4" />}{t("signIn")}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
