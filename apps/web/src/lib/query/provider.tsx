"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  getTravelApiConfiguration,
  type TravelApi,
  type TravelApiConfiguration,
} from "@/lib/api";
import type { GetAccessToken } from "@/lib/api/client";

const TravelApiContext = createContext<TravelApiConfiguration | null>(null);

export function QueryProvider({
  children,
  configuration,
  getAccessToken,
  sessionRevision = 0,
}: {
  children: ReactNode;
  configuration?: TravelApiConfiguration;
  getAccessToken?: GetAccessToken;
  sessionRevision?: number;
}) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 30_000 },
      mutations: { retry: false },
    },
  }));
  // Derive the api configuration lazily so the test harness can inject a
  // new mock api on each render without us caching the first one.
  const travelApiConfiguration = useMemo(
    () => configuration ?? getTravelApiConfiguration(getAccessToken),
    [configuration, getAccessToken],
  );
  const previousSessionRevision = useRef(sessionRevision);

  useEffect(() => {
    if (previousSessionRevision.current !== sessionRevision) {
      queryClient.clear();
      previousSessionRevision.current = sessionRevision;
    }
  }, [queryClient, sessionRevision]);

  return (
    <QueryClientProvider client={queryClient}>
      <TravelApiContext.Provider value={travelApiConfiguration}>
        {children}
      </TravelApiContext.Provider>
    </QueryClientProvider>
  );
}
export function useTravelApi(): TravelApi {
  const configuration = useContext(TravelApiContext);
  if (!configuration) {
    throw new Error("useTravelApi must be used within QueryProvider");
  }
  return configuration.api;
}

/** Optional for session-only UI that must remain usable before API wiring. */
export function useOptionalTravelApi(): TravelApi | null {
  return useContext(TravelApiContext)?.api ?? null;
}
