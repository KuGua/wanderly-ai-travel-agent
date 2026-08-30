"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { PlaceCandidateCard, TripPlaceRow } from "./place-candidate-card";
import {
  useAdoptTripPlace,
  useProposeTripPlace,
  useRevokeTripPlace,
  useSearchPlaceCandidates,
  useTripPlaces,
} from "@/lib/query/hooks";
import type { PlaceCandidate, TripPlaceKind, TripPlaceVisibility } from "@/lib/api/contracts";

const KIND_VALUES: TripPlaceKind[] = ["ATTRACTION", "HOTEL", "RESTAURANT", "TRANSPORT_HUB", "OTHER"];

/**
 * Phase 2 — `PlacesPanel`. Lists existing TripPlaces for the trip and lets
 * the user run a new keyword search. The panel is intentionally inert with
 * respect to the map (the trip-side globe remains a read-only companion);
 * it only ever calls server-authoritative endpoints and reflects their
 * loading + error states.
 */
export interface PlacesPanelProps {
  tripId: string;
  destinationCandidates: string[];
}

export function PlacesPanel({ tripId, destinationCandidates }: PlacesPanelProps) {
  const t = useTranslations("trips.workspace.poi");
  const tripPlacesQuery = useTripPlaces(tripId);
  const searchMutation = useSearchPlaceCandidates(tripId);
  const proposeMutation = useProposeTripPlace(tripId);
  const adoptMutation = useAdoptTripPlace(tripId);
  const revokeMutation = useRevokeTripPlace(tripId);
  const [keyword, setKeyword] = useState("");
  const [destinationId, setDestinationId] = useState(destinationCandidates[0] ?? "");
  const [category, setCategory] = useState<TripPlaceKind>("ATTRACTION");
  const [searchError, setSearchError] = useState<string | null>(null);

  const busy =
    searchMutation.isPending ||
    proposeMutation.isPending ||
    adoptMutation.isPending ||
    revokeMutation.isPending;

  async function onSearch() {
    if (!keyword.trim() || !destinationId) return;
    setSearchError(null);
    try {
      await searchMutation.mutateAsync({ input: { destinationId, keyword, category } });
    } catch (error) {
      setSearchError((error as Error).message ?? t("errors.search"));
    }
  }

  function onAdopt(input: { candidate: PlaceCandidate; visibility: TripPlaceVisibility; kind: TripPlaceKind }) {
    const idempotencyKey = crypto.randomUUID();
    proposeMutation.mutate(
      { input: { candidate: input.candidate, visibility: input.visibility, kind: input.kind }, idempotencyKey },
      {
        onSuccess: (result) => {
          if (result.status === "PROPOSED") {
            adoptMutation.mutate({
              input: { placeId: result.placeId },
              idempotencyKey: crypto.randomUUID(),
            });
          }
        },
        onError: () => setSearchError(t("errors.adopt")),
      },
    );
  }

  return (
    <section className="wanderly-edge wanderly-r-md wanderly-shadow p-4 flex flex-col gap-4" aria-busy={busy}>
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <span className="text-xs text-[var(--w-muted)]">{t("attribution")}</span>
      </header>
      <form
        className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          void onSearch();
        }}
      >
        <select
          aria-label={t("fields.destination")}
          className="wanderly-input"
          value={destinationId}
          onChange={(e) => setDestinationId(e.target.value)}
        >
          {destinationCandidates.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          aria-label={t("fields.category")}
          className="wanderly-input"
          value={category}
          onChange={(e) => setCategory(e.target.value as TripPlaceKind)}
        >
          {KIND_VALUES.map((k) => (
            <option key={k} value={k}>{t(`kind.${k}`)}</option>
          ))}
        </select>
        <input
          aria-label={t("fields.keyword")}
          className="wanderly-input"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t("fields.keywordPlaceholder")}
        />
        <button type="submit" className="wanderly-btn-primary" disabled={busy}>
          {t("search")}
        </button>
      </form>
      {searchError ? (
        <p role="alert" className="text-xs text-red-700">{searchError}</p>
      ) : null}
      {searchMutation.data ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          {searchMutation.data.candidates.length === 0 ? (
            <p className="text-xs text-[var(--w-muted)]">{t("noResults")}</p>
          ) : (
            searchMutation.data.candidates.map((c) => (
              <PlaceCandidateCard
                key={c.candidateId}
                candidate={c}
                busy={busy}
                onAdopt={onAdopt}
                onDismiss={(id) => {
                  setSearchError(null);
                  searchMutation.reset();
                  void id;
                }}
              />
            ))
          )}
        </div>
      ) : null}
      <hr className="border-[var(--w-divider)]" />
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t("savedTitle")}</h3>
        {tripPlacesQuery.isLoading ? (
          <p className="text-xs text-[var(--w-muted)]">{t("loading")}</p>
        ) : tripPlacesQuery.data?.places.length ? (
          tripPlacesQuery.data.places.map((p) => (
            <TripPlaceRow
              key={p.id}
              place={p}
              busy={revokeMutation.isPending}
              onRevoke={({ placeId, reason }) =>
                revokeMutation.mutate({ input: { placeId, reason }, idempotencyKey: crypto.randomUUID() })
              }
            />
          ))
        ) : (
          <p className="text-xs text-[var(--w-muted)]">{t("empty")}</p>
        )}
      </div>
    </section>
  );
}