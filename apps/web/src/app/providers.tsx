"use client";

import type { ReactNode } from "react";

import { AuthProvider, useAuth } from "@/lib/auth/auth-provider";
import { QueryProvider } from "@/lib/query/provider";

export function AppProviders({ children }: { children: ReactNode }) {
  return <AuthProvider><AuthenticatedQueryProvider>{children}</AuthenticatedQueryProvider></AuthProvider>;
}

function AuthenticatedQueryProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return (
    <QueryProvider getAccessToken={auth.getAccessToken} sessionRevision={auth.sessionRevision}>
      {children}
    </QueryProvider>
  );
}
