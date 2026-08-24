"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useState, type ReactNode } from "react";

import {
  getTravelApiConfiguration,
  type TravelApi,
  type TravelApiConfiguration,
} from "@/lib/api";

const TravelApiContext = createContext<TravelApiConfiguration | null>(null);

export function QueryProvider({
  children,
  configuration,
}: {
  children: ReactNode;
  configuration?: TravelApiConfiguration;
}) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 30_000 },
      mutations: { retry: false },
    },
  }));
  const [travelApiConfiguration] = useState(
    () => configuration ?? getTravelApiConfiguration(),
  );

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

export function useDataMode() {
  const configuration = useContext(TravelApiContext);
  if (!configuration) {
    throw new Error("useDataMode must be used within QueryProvider");
  }
  return configuration.mode;
}
