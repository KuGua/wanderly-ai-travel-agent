"use client";

import { useEffect } from "react";

import { resolveApiBaseUrl } from "@/lib/api";
import { createUiDiagnosticReporter, getCurrentUiScreen } from "@/lib/observability/ui-diagnostics";

export default function LocaleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Route-level errors occur below AppProviders, so this tiny boundary uses
    // no page data and never serialises the error object.
    const reporter = createUiDiagnosticReporter({
      apiBaseUrl: `${resolveApiBaseUrl()}/api/v1`,
      getAccessToken: () => localStorage.getItem("wanderly_auth_token") ?? sessionStorage.getItem("wanderly_auth_token"),
    });
    void reporter.send({
      eventType: "ui_client_error",
      action: "frontend.runtime",
      screen: getCurrentUiScreen(),
      outcome: "failure",
      errorCategory: "render",
    });
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-bold">Something went wrong</h1>
      <p className="text-muted-foreground">Please try again. Your data has not been changed by this error screen.</p>
      <button type="button" onClick={() => reset()} className="min-h-11 rounded-xl bg-primary px-5 font-semibold text-primary-foreground">
        Try again
      </button>
    </main>
  );
}
