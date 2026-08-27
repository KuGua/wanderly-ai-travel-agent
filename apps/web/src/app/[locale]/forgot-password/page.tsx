"use client";

import { ArrowLeft, CheckCircle, LoaderCircle, Mail, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { requestPasswordReset, resetPassword, verifyResetCode } from "@/lib/auth/custom-browser-auth";

type Step = "email" | "code" | "password" | "success";

export default function ForgotPasswordPage() {
  const t = useTranslations("forgotPassword");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [usesEmailCode, setUsesEmailCode] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [redirect, setRedirect] = useState(5);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const redirectRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const startCooldown = useCallback(() => {
    setCooldown(60);
    clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      clearInterval(cooldownRef.current);
      clearInterval(redirectRef.current);
    };
  }, []);

  async function handleEmailSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await requestPasswordReset(email);
      if (result.mode === "direct" && result.resetToken) {
        setUsesEmailCode(false);
        setResetToken(result.resetToken);
        setStep("password");
        return;
      }
      setUsesEmailCode(true);
      if (result.developmentCode) setCode(result.developmentCode);
      startCooldown();
      setStep("code");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("sendFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (cooldown > 0) return;
    setError(null);
    setLoading(true);

    try {
      const result = await requestPasswordReset(email);
      startCooldown();
      setCode(result.developmentCode ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("sendFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCodeSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      setError(t("codeInvalid"));
      return;
    }

    setLoading(true);

    try {
      const token = await verifyResetCode(email, code);
      setResetToken(token);
      setStep("password");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("codeFailed"));
    } finally {
      setLoading(false);
    }
  }

  function validatePassword(): string | null {
    if (password.length < 8) return t("passwordTooShort");
    if (!/[A-Z]/.test(password)) return t("passwordNeedUppercase");
    if (!/[a-z]/.test(password)) return t("passwordNeedLowercase");
    if (!/[0-9]/.test(password)) return t("passwordNeedNumber");
    if (password !== confirmPassword) return t("passwordMismatch");
    return null;
  }

  async function handlePasswordSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const validationError = validatePassword();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);

    try {
      await resetPassword({ email, resetToken, password, confirmPassword });
      setStep("success");
      setRedirect(5);
      redirectRef.current = setInterval(() => {
        setRedirect((prev) => {
          if (prev <= 1) {
            clearInterval(redirectRef.current);
            router.push("/login");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("resetFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] items-center justify-center bg-background px-4 landscape:min-h-screen">
      <div className="w-full max-w-sm">
        <Link
          href={step === "success" ? "/login" : step === "email" ? "/login" : "#"}
          onClick={step !== "email" && step !== "success" ? (e) => {
            e.preventDefault();
            setStep(step === "code" || !usesEmailCode ? "email" : "code");
            setError(null);
          } : undefined}
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {step === "success" ? t("backToLogin") : step === "email" ? t("backToLogin") : t("back")}
        </Link>

        <div className="rounded-[20px] border border-border bg-card p-6 shadow-lg">
          {step === "email" && (
            <>
              <div className="mb-6 text-center">
                <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-sidebar text-white">
                  <Mail className="size-5" />
                </div>
                <h1 className="text-xl font-bold tracking-tight text-foreground">{t("heading")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("body")}</p>
              </div>

              <form onSubmit={handleEmailSubmit} className="space-y-4">
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
                </div>

                {error ? <p className="text-xs text-destructive">{error}</p> : null}

                <button
                  type="submit"
                  disabled={loading}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-sidebar font-bold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:opacity-60"
                >
                  {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  {t("continue")}
                </button>
              </form>
            </>
          )}

          {step === "code" && (
            <>
              <div className="mb-6 text-center">
                <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-sidebar text-white">
                  <ShieldCheck className="size-5" />
                </div>
                <h1 className="text-xl font-bold tracking-tight text-foreground">{t("codeHeading")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("codeBody", { email })}</p>
              </div>

              <form onSubmit={handleCodeSubmit} className="space-y-4">
                <div>
                  <label htmlFor="code" className="mb-1.5 block text-sm font-medium text-foreground">
                    {t("codeLabel")}
                  </label>
                  <input
                    id="code"
                    type="text"
                    required
                    inputMode="numeric"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="h-10 w-full rounded-lg border border-input bg-background px-3 text-center text-lg font-mono tracking-[0.5em] text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring/30"
                    placeholder="000000"
                  />
                </div>

                {error ? <p className="text-xs text-destructive">{error}</p> : null}

                <button
                  type="submit"
                  disabled={loading || code.length !== 6}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-sidebar font-bold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:opacity-60"
                >
                  {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  {t("verifyCode")}
                </button>

                <div className="text-center text-sm">
                  {cooldown > 0 ? (
                    <span className="text-muted-foreground">{t("resendIn", { seconds: cooldown })}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={loading}
                      className="text-primary underline underline-offset-2 transition-colors hover:text-primary/80 disabled:opacity-60"
                    >
                      {t("resend")}
                    </button>
                  )}
                </div>
              </form>
            </>
          )}

          {step === "password" && (
            <>
              <div className="mb-6 text-center">
                <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-sidebar text-white">
                  <ShieldCheck className="size-5" />
                </div>
                <h1 className="text-xl font-bold tracking-tight text-foreground">{t("newPasswordHeading")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("newPasswordBody")}</p>
              </div>

              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div>
                  <label htmlFor="newPassword" className="mb-1.5 block text-sm font-medium text-foreground">
                    {t("newPassword")}
                  </label>
                  <input
                    id="newPassword"
                    type="password"
                    required
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring/30"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">{t("passwordHint")}</p>
                </div>

                <div>
                  <label htmlFor="confirmNewPassword" className="mb-1.5 block text-sm font-medium text-foreground">
                    {t("confirmNewPassword")}
                  </label>
                  <input
                    id="confirmNewPassword"
                    type="password"
                    required
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-ring/30"
                  />
                </div>

                {error ? <p className="text-xs text-destructive">{error}</p> : null}

                <button
                  type="submit"
                  disabled={loading}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-sidebar font-bold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:opacity-60"
                >
                  {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  {t("resetPassword")}
                </button>
              </form>
            </>
          )}

          {step === "success" && (
            <div className="text-center">
              <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-green-600 text-white">
                <CheckCircle className="size-5" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-foreground">{t("successHeading")}</h1>
              <p className="mt-2 text-sm text-muted-foreground">{t("successBody")}</p>
              <p className="mt-3 text-sm text-muted-foreground">{t("redirecting", { seconds: redirect })}</p>
              <Link
                href="/login"
                className="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-sidebar px-6 font-bold text-white transition-opacity hover:opacity-90"
              >
                {t("backToLogin")}
              </Link>
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {tCommon("brandTagline")}
        </p>
      </div>
    </div>
  );
}
