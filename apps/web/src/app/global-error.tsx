"use client";

import { useEffect } from "react";

import { resolveApiBaseUrl } from "@/lib/api";
import { createUiDiagnosticReporter } from "@/lib/observability/ui-diagnostics";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    const reporter = createUiDiagnosticReporter({
      apiBaseUrl: `${resolveApiBaseUrl()}/api/v1`,
      getAccessToken: () => localStorage.getItem("wanderly_auth_token") ?? sessionStorage.getItem("wanderly_auth_token"),
    });
    void reporter.send({ eventType: "ui_client_error", action: "frontend.runtime", screen: "unknown", outcome: "failure", errorCategory: "render" });
  }, []);

  return (
    <html lang="en">
      <body>
        <main style={{ fontFamily: "system-ui, sans-serif", margin: "4rem auto", maxWidth: "36rem", padding: "1.5rem", textAlign: "center" }}>
          <h1>Something went wrong</h1>
          <p>Please try again.</p>
          <button type="button" onClick={() => reset()}>Try again</button>
        </main>
      </body>
    </html>
  );
}
