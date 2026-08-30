"use client";

import type { ReactNode } from "react";

import { AuthProvider, useAuth } from "@/lib/auth/auth-provider";
import { QueryProvider } from "@/lib/query/provider";
import { ExplorationSessionProvider } from "@/lib/exploration/exploration-session-provider";
import { FrontendErrorReporter } from "@/components/observability/frontend-error-reporter";

export function AppProviders({ children }: { children: ReactNode }) {
  return <AuthProvider><FrontendErrorReporter /><AuthenticatedQueryProvider>{children}</AuthenticatedQueryProvider></AuthProvider>;
}

function AuthenticatedQueryProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return (
    <QueryProvider getAccessToken={auth.getAccessToken} sessionRevision={auth.sessionRevision}>
      <ExplorationSessionProvider>{children}</ExplorationSessionProvider>
    </QueryProvider>
  );
}
