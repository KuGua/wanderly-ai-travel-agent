"use client";

import { ArrowLeft, LoaderCircle, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { useAuth } from "@/lib/auth/auth-provider";
import { registerUser } from "@/lib/auth/custom-browser-auth";

export default function RegisterPage() {
  const t = useTranslations("register");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const auth = useAuth();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function validate(): Record<string, string> {
    const result: Record<string, string> = {};

    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      result.username = t("usernameInvalid");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      result.email = t("emailInvalid");
    }
    if (password.length < 8) {
      result.password = t("passwordTooShort");
    } else if (!/[A-Z]/.test(password)) {
      result.password = t("passwordNeedUppercase");
    } else if (!/[a-z]/.test(password)) {
      result.password = t("passwordNeedLowercase");
    } else if (!/[0-9]/.test(password)) {
      result.password = t("passwordNeedNumber");
    }
    if (password !== confirmPassword) {
      result.confirmPassword = t("passwordMismatch");
    }

    return result;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setServerError(null);

    const validationErrors = validate();
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    setLoading(true);
    try {
      await registerUser({ username, email, password, confirmPassword });
      await auth.signIn(username, password);
      router.push("/home");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("failed");
      if (message.includes("already taken")) {
        setServerError(t("alreadyTaken"));
      } else {
        setServerError(message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center bg-background px-4 landscape:min-h-screen">
      <div className="w-full max-w-sm">
        <Link href="/login" className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-4" />
          {t("backToLogin")}
        </Link>

        <div className="rounded-[20px] border border-border bg-card p-6 shadow-lg">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-sidebar text-white">
              <UserPlus className="size-5" />
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
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring/30"
                placeholder={t("usernamePlaceholder")}
              />
              {errors.username ? <p className="mt-1 text-xs text-destructive">{errors.username}</p> : null}
            </div>

            <div>
              <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-foreground">
                {t("email")}
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring/30"
                placeholder={t("emailPlaceholder")}
              />
              {errors.email ? <p className="mt-1 text-xs text-destructive">{errors.email}</p> : null}
            </div>

            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-foreground">
                {t("password")}
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring/30"
              />
              {errors.password ? <p className="mt-1 text-xs text-destructive">{errors.password}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">{t("passwordHint")}</p>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="mb-1.5 block text-sm font-medium text-foreground">
                {t("confirmPassword")}
              </label>
              <input
                id="confirmPassword"
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring/30"
              />
              {errors.confirmPassword ? <p className="mt-1 text-xs text-destructive">{errors.confirmPassword}</p> : null}
            </div>

            {serverError ? (
              <p className="text-xs text-destructive">{serverError}</p>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-sidebar font-bold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:opacity-60"
            >
              {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {t("submit")}
            </button>
          </form>

          <div className="mt-5 text-center text-sm">
            <span className="text-muted-foreground">{t("haveAccount")}</span>{" "}
            <Link href="/login" className="font-medium text-primary transition-colors hover:text-primary/80">
              {t("signInLink")}
            </Link>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {tCommon("brandTagline")}
        </p>
      </div>
    </div>
  );
}
