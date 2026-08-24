"use client";

import type { ReactNode } from "react";

import { QueryProvider } from "@/lib/query/provider";

export function AppProviders({ children }: { children: ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
