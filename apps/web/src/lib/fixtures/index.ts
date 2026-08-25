"use client";

import { useLocale } from "next-intl";

import { fixtureProfile as enProfile } from "./profiles";
import { fixtureProfile as zhProfile } from "./profiles.zh";
import { fixtureTrips as enTrips } from "./trips";
import { fixtureTrips as zhTrips } from "./trips.zh";

/**
 * Returns the profile fixture appropriate for the active locale. Fixture
 * data (display name, nationality, departure city, interests, trip name) is
 * localized; wire-format fields (UUIDs, timestamps, ISO dates, currency) are
 * not.
 */
export function useLocalizedProfileFixture() {
  const locale = useLocale();
  return locale === "zh" ? zhProfile : enProfile;
}

export function useLocalizedTripsFixture() {
  const locale = useLocale();
  return locale === "zh" ? zhTrips : enTrips;
}