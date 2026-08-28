"use client";

import { useQuery } from "@tanstack/react-query";

import type {
  LocationIntroductionInput,
  LocationIntroductionResponse,
} from "@/lib/api/contracts";
import { useTravelApi } from "./provider";
import { locationIntroductionKeys } from "./keys";

export type LocationIntroductionState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; content: string; cacheStatus: "HIT" | "MISS"; expiresAt: string }
  | { status: "generating"; retryAfterMs: number }
  | { status: "unavailable" };

interface UseLocationIntroductionOptions {
  /** Skip the query when null (e.g. no stable `sourceId` selected yet). */
  sourceId: string | null;
  locale: "en" | "zh";
}

const POLL_INTERVAL_MS = 500;

/**
 * Read-through query for the cached, non-personalized location
 * introduction. The hook returns a discriminated union so the drawer
 * panel can branch on `status`. Polling stops as soon as the server
 * responds `READY`. TanStack Query cancels in-flight requests when the
 * `sourceId` selector changes or the component unmounts; that does NOT
 * release any server-side generation lease.
 */
export function useLocationIntroduction(options: UseLocationIntroductionOptions): LocationIntroductionState {
  const api = useTravelApi();
  const enabled = Boolean(options.sourceId);

  const query = useQuery<LocationIntroductionState, Error>({
    queryKey: enabled
      ? locationIntroductionKeys.detail({ sourceId: options.sourceId as string, locale: options.locale })
      : ["location-introductions", "disabled"],
    enabled,
    retry: (failureCount, err) => {
      // 503 LOCATION_INTRODUCTION_UNAVAILABLE must surface as a single
      // manual retry, not an automatic retry storm.
      if (err instanceof Error && /LOCATION_INTRODUCTION_UNAVAILABLE/.test(err.message)) return false;
      return failureCount < 1;
    },
    queryFn: async ({ signal }) => {
      if (!options.sourceId) return { status: "idle" as const };
      try {
        const response: LocationIntroductionResponse = await api.getLocationIntroduction({
          sourceId: options.sourceId,
          locale: options.locale,
        } satisfies LocationIntroductionInput);
        if (response.status === "READY") {
          return {
            status: "ready" as const,
            content: response.content,
            cacheStatus: response.cacheStatus,
            expiresAt: response.expiresAt,
          };
        }
        return {
          status: "generating" as const,
          retryAfterMs: response.retryAfterMs,
        };
      } catch (err) {
        // ApiClient normalizes HTTP errors into `TravelApiError` with a
        // `message`; the server's LOCATION_INTRODUCTION_UNAVAILABLE code
        // maps to that message. Anything else falls through to "unavailable"
        // because the panel's contract is binary: retry or give up.
        void err;
        return { status: "unavailable" as const };
      }
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === "generating") return POLL_INTERVAL_MS;
      return false;
    },
    refetchIntervalInBackground: false,
    staleTime: (query) => {
      const data = query.state.data;
      if (data?.status === "ready") {
        const ms = Date.parse(data.expiresAt) - Date.now();
        return Math.max(ms, 0);
      }
      return 30_000;
    },
    gcTime: 60_000,
  });

  if (!enabled) return { status: "idle" };
  if (query.isPending) return { status: "loading" };
  return query.data ?? { status: "loading" };
}