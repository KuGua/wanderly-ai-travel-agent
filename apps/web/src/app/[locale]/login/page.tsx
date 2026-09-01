"use client";

import { ArrowLeft, LoaderCircle, LogIn } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth/auth-provider";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const t = useTranslations("login");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const auth = useAuth();
  const supportsPasswordReset = process.env.NEXT_PUBLIC_AUTH_MODE === "custom";
  // Sends a member back to the invitation link they came from (see
  // JoinTripInvitation) instead of always landing on /home. Only ever a
  // same-origin relative path built by this app, never taken verbatim from
  // an external source.
  const redirectTarget = useSearchParams().get("redirect");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const success = await auth.signIn(username, password, remember);
      if (success) {
        router.push((redirectTarget?.startsWith("/") ? redirectTarget : "/home") as "/home");
      } else {
        setError(t("failed"));
      }
    } catch {
      setError(t("failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center bg-background px-4 landscape:min-h-screen">
      <div className="w-full max-w-sm">
        <Link href="/home" className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-4" />
          {t("backToExplore")}
        </Link>

        <div className="bg-card p-6 wanderly-edge wanderly-r-lg wanderly-shadow">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 grid size-12 place-items-center bg-[var(--w-info)] text-[var(--w-ink)] wanderly-edge wanderly-r-md wanderly-shadow-xs">
              <LogIn className="size-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">{t("heading")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("body")}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="username" className="mb-1.5 block text-sm font-medium text-foreground">
                {t("username")}
              </label>
              <input
                id="username"
                type="text"
                required
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-11 w-full bg-card px-3 text-sm text-foreground outline-none wanderly-edge wanderly-r-sm"
                placeholder={t("usernamePlaceholder")}
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-foreground">
                {t("password")}
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 w-full bg-card px-3 text-sm text-foreground outline-none wanderly-edge wanderly-r-sm"
              />
            </div>

            <label htmlFor="rememberMe" className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                id="rememberMe"
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="size-4 accent-[var(--w-highlight)] wanderly-edge-thin wanderly-r-xs"
              />
              {t("rememberMe")}
            </label>

            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className="flex h-11 w-full items-center justify-center gap-2 font-extrabold wanderly-edge wanderly-r-md wanderly-shadow-sm wanderly-press wanderly-action"
            >
              {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {t("submit")}
            </button>
          </form>

          <div className="mt-5 space-y-2 text-center text-sm">
            <div>
              <Link href="/register" className="font-medium text-primary transition-colors hover:text-primary/80">
                {t("createAccount")}
              </Link>
            </div>
            {supportsPasswordReset ? (
              <div>
                <Link href="/forgot-password" className="text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground">
                  {t("forgotPassword")}
                </Link>
              </div>
            ) : null}
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {tCommon("brandTagline")}
        </p>
      </div>
    </div>
  );
}
