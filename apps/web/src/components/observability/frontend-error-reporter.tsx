"use client";

import { useEffect } from "react";

import { createUiDiagnosticReporter, getCurrentUiScreen } from "@/lib/observability/ui-diagnostics";
import { useAuth } from "@/lib/auth/auth-provider";

/** Captures browser errors without serialising Error, stack, URL, or user input. */
export function FrontendErrorReporter() {
  const auth = useAuth();

  useEffect(() => {
    const reporter = createUiDiagnosticReporter({
      apiBaseUrl: `${process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000"}/api/v1`,
      getAccessToken: auth.getAccessToken,
    });
    const recent = new Map<string, number>();
    const report = (eventType: "ui_client_error", errorCategory: "render" | "unhandled") => {
      const key = `${eventType}:${errorCategory}:${getCurrentUiScreen()}`;
      const now = Date.now();
      if ((recent.get(key) ?? 0) + 30_000 > now) return;
      recent.set(key, now);
      void reporter.send({ eventType, action: "frontend.runtime", screen: getCurrentUiScreen(), outcome: "failure", errorCategory });
    };
    const onError = () => report("ui_client_error", "render");
    const onUnhandledRejection = () => report("ui_client_error", "unhandled");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [auth.getAccessToken]);

  return null;
}
