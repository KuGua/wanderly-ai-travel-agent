"use client";

import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import type { LocationIntroductionInput, LocationIntroductionResponse } from "@/lib/api/contracts";
import { useTravelApi } from "./provider";
import { locationIntroductionKeys } from "./keys";

export type LocationIntroductionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; content: string; cacheStatus: "HIT" | "MISS"; expiresAt: string }
  | { status: "generating"; retryAfterMs: number }
  | { status: "unavailable" };

export interface LocationIntroductionQuery {
  state: LocationIntroductionState;
  retry: () => void;
}

interface UseLocationIntroductionOptions {
  sourceId: string | null;
  locale: "en" | "zh";
}

const MAX_GENERATING_RESPONSES = 8;

export function useLocationIntroduction(options: UseLocationIntroductionOptions): LocationIntroductionQuery {
  const api = useTravelApi();
  const enabled = Boolean(options.sourceId);
  const requestKey = `${options.sourceId ?? ""}:${options.locale}`;
  const generationAttempts = useRef({ key: requestKey, count: 0 });
  if (generationAttempts.current.key !== requestKey) {
    generationAttempts.current = { key: requestKey, count: 0 };
  }

  const query = useQuery<LocationIntroductionState, Error>({
    queryKey: enabled
      ? locationIntroductionKeys.detail({ sourceId: options.sourceId as string, locale: options.locale })
      : ["location-introductions", "disabled"],
    enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!options.sourceId) return { status: "idle" as const };
      const response: LocationIntroductionResponse = await api.getLocationIntroduction({
        sourceId: options.sourceId,
        locale: options.locale,
      } satisfies LocationIntroductionInput, { signal });
      if (response.status === "READY") {
        generationAttempts.current.count = 0;
        return { status: "ready" as const, content: response.content, cacheStatus: response.cacheStatus, expiresAt: response.expiresAt };
      }
      generationAttempts.current.count += 1;
      if (generationAttempts.current.count > MAX_GENERATING_RESPONSES) return { status: "unavailable" as const };
      return { status: "generating" as const, retryAfterMs: response.retryAfterMs };
    },
    refetchInterval: (current) => current.state.data?.status === "generating"
      ? current.state.data.retryAfterMs
      : false,
    refetchIntervalInBackground: false,
    staleTime: (current) => {
      const data = current.state.data;
      return data?.status === "ready" ? Math.max(Date.parse(data.expiresAt) - Date.now(), 0) : 0;
    },
    gcTime: 60_000,
  });

  const retry = () => {
    generationAttempts.current.count = 0;
    void query.refetch();
  };
  if (!enabled) return { state: { status: "idle" }, retry };
  if (query.isPending) return { state: { status: "loading" }, retry };
  if (query.isError) return { state: { status: "unavailable" }, retry };
  return { state: query.data ?? { status: "loading" }, retry };
}
