"use client";

import { AlertCircle, Database, LoaderCircle, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { useErrorMessage } from "@/lib/api/use-error-message";

export function DemoDataBadge() {
  const t = useTranslations("common");
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">
      <Database aria-hidden="true" className="size-3.5" />
      {t("demoBadge")}
    </span>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center gap-3 rounded-3xl border bg-card p-6 text-muted-foreground" aria-busy="true" aria-live="polite">
      <LoaderCircle aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
      {label}
    </div>
  );
}

export function ErrorState({ error, title }: { error: unknown; title?: string }) {
  const t = useTranslations("common");
  const getMessage = useErrorMessage();
  const isUnauthorized =
    typeof error === "object" && error !== null && "isUnauthorized" in error
      ? Boolean((error as { isUnauthorized?: boolean }).isUnauthorized)
      : false;
  const Icon = isUnauthorized ? ShieldAlert : AlertCircle;

  return (
    <section role="alert" className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6">
      <Icon aria-hidden="true" className="mb-4 size-6 text-destructive" />
      <h2 className="font-semibold">{isUnauthorized ? t("errorUnauthorized") : (title ?? t("errorTitleDefault"))}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{getMessage(error)}</p>
      {typeof error === "object" && error !== null && "correlationId" in error ? (
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-3 font-medium">{t("errorTechnicalDetails")}</summary>
          <p>
            {t("errorCorrelationId", {
              correlationId: String((error as { correlationId?: unknown }).correlationId),
            })}
          </p>
        </details>
      ) : null}
    </section>
  );
}