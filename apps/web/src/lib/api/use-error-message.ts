"use client";

import { useTranslations } from "next-intl";

import { TravelApiError } from "@/lib/api/errors";

const KNOWN_STATUS_KEYS = new Set([
  "401",
  "403",
  "404",
  "409",
  "422",
  "500",
  "502",
  "503",
]);

/**
 * Returns a function that converts an arbitrary thrown value into a
 * user-facing, locale-aware message. Server-supplied `message` strings are
 * surfaced verbatim when no localized status-code mapping exists.
 */
export function useErrorMessage() {
  const t = useTranslations("errors");
  return (error: unknown): string => {
    if (error instanceof TravelApiError) {
      if (error.isUnauthorized) return t("unauthorized");
      if (error.statusCode !== null) {
        const key = String(error.statusCode);
        if (KNOWN_STATUS_KEYS.has(key)) {
          return t(`byStatusCode.${key}`);
        }
        // Unknown status — fall back to network/generic to avoid surfacing
        // raw server strings as UI copy.
        return t("byStatusCode.fallback");
      }
      return error.message || t("byStatusCode.fallback");
    }
    return t("generic");
  };
}