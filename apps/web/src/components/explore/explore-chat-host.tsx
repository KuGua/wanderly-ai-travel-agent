"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import type { ConversationPlace } from "@/lib/api/contracts";
import { TravelAgentChat } from "./travel-agent-chat";
import { useTravelApi } from "@/lib/query/provider";
import {
  useCreatePersonalTrip,
  useGetOrCreateDefaultTripThread,
  useTripThreads,
  useTrips,
} from "@/lib/query/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { tripKeys } from "@/lib/query/keys";
import type { ChatThreadStatus } from "./travel-agent-chat";

type AutoAskRequest = {
  nonce: string;
  place: ConversationPlace;
  context: string;
};

type ExploreChatHostProps = {
  open?: boolean;
  onOpen?: () => void;
  onDismiss?: () => void;
  selectedPlace?: Parameters<typeof TravelAgentChat>[0]["selectedPlace"];
  autoAskRequest?: AutoAskRequest | null;
  onAutoAskConsumed?: (nonce: string) => void;
  onConversationText?: (text: string) => void;
};

export function ExploreChatHost({
  open = false,
  onOpen = () => {},
  onDismiss = () => {},
  selectedPlace,
  autoAskRequest,
  onAutoAskConsumed,
  onConversationText,
}: ExploreChatHostProps) {
  const t = useTranslations("explore.chat");
  const tripsQuery = useTrips();
  const trips = useMemo(() => tripsQuery.data?.trips ?? [], [tripsQuery.data?.trips]);
  const tripsLoaded = tripsQuery.data !== undefined;

  const [userSelectedTripId, setUserSelectedTripId] = useState<string | null>(null);

  const autoActiveTripId = useMemo(() => {
    if (!tripsLoaded) return null;
    if (trips.length === 0) return null;
    return trips[0].id;
  }, [trips, tripsLoaded]);
  const activeTripId = userSelectedTripId ?? autoActiveTripId;

  const activeTrip = useMemo(
    () => trips.find((trip) => trip.id === activeTripId) ?? null,
    [trips, activeTripId],
  );

  return (
    <div data-testid="explore-chat-host" className="contents">
      <ExploreChatHostBody
        selectedPlace={selectedPlace}
        autoAskRequest={autoAskRequest}
        onAutoAskConsumed={onAutoAskConsumed}
        onConversationText={onConversationText}
        open={open}
        onOpen={onOpen}
        onDismiss={onDismiss}
        tripsCount={trips.length}
        tripsLoaded={tripsLoaded}
        tripsFailed={tripsQuery.isError}
        onRetryTrips={() => { void tripsQuery.refetch(); }}
        activeTrip={activeTrip}
        allTrips={trips}
        onSelectTrip={setUserSelectedTripId}
        pickerLabel={t("tripPickerLabel")}
        switchTripAria={t("switchTripAria")}
      />
    </div>
  );
}

type BodyProps = {
  selectedPlace?: Parameters<typeof TravelAgentChat>[0]["selectedPlace"];
  autoAskRequest?: AutoAskRequest | null;
  onAutoAskConsumed?: (nonce: string) => void;
  onConversationText?: (text: string) => void;
  open: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  tripsCount: number;
  tripsLoaded: boolean;
  tripsFailed: boolean;
  onRetryTrips: () => void;
  activeTrip: TripSummary | null;
  allTrips: TripSummary[];
  onSelectTrip: (tripId: string) => void;
  pickerLabel: string;
  switchTripAria: string;
};

type TripSummary = {
  id: string;
  name: string;
};

function ExploreChatHostBody({
  selectedPlace,
  autoAskRequest,
  onAutoAskConsumed,
  onConversationText,
  open,
  onOpen,
  onDismiss,
  tripsCount,
  tripsLoaded,
  tripsFailed,
  onRetryTrips,
  activeTrip,
  allTrips,
  onSelectTrip,
  pickerLabel,
  switchTripAria,
}: BodyProps) {
  const queryClient = useQueryClient();
  const api = useTravelApi();
  const createPersonalTrip = useCreatePersonalTrip();
  const [personalTripId, setPersonalTripId] = useState<string | null>(null);
  const personalInFlightRef = useRef(false);

  const provisionPersonalTrip = useCallback(() => {
    if (personalInFlightRef.current || personalTripId) return;
    personalInFlightRef.current = true;
    void createPersonalTrip
      .mutateAsync({
        departureCities: ["San Francisco"],
        destinationCandidates: ["Tokyo", "Bangkok"],
      })
      .then((created: { id: string }) => {
        setPersonalTripId(created.id);
        void queryClient.invalidateQueries({ queryKey: tripKeys.list });
      })
      .catch(() => {
        // The visible retry control owns the next attempt.
      })
      .finally(() => {
        personalInFlightRef.current = false;
      });
  }, [createPersonalTrip, personalTripId, queryClient]);

  // When the user has zero trips, lazily create a personal scratch trip
  // (one-time) so we can bind a default thread to it.
  useEffect(() => {
    if (!tripsLoaded) return;
    if (tripsCount > 0) return;
    if (personalTripId) return;
    provisionPersonalTrip();
  }, [tripsLoaded, tripsCount, personalTripId, provisionPersonalTrip]);

  const activeTripId = activeTrip?.id ?? personalTripId;
  const threadsQuery = useTripThreads(activeTripId);
  const threads = useMemo(() => threadsQuery.data?.threads ?? [], [threadsQuery.data?.threads]);
  const ensureDefault = useGetOrCreateDefaultTripThread(activeTripId ?? "");
  const autoProvisionAttemptedRef = useRef(false);

  // Eager auto-provision the per-trip default thread once we know the
  // caller's threads list is empty. Mirrors trip-workspace.tsx §8.1.
  useEffect(() => {
    if (!activeTripId) {
      autoProvisionAttemptedRef.current = false;
      return;
    }
    if (autoProvisionAttemptedRef.current) return;
    if (!threadsQuery.data) return;
    if (threads.length !== 0) return;
    autoProvisionAttemptedRef.current = true;
    void ensureDefault.mutateAsync().catch(() => {
      autoProvisionAttemptedRef.current = false;
    });
  }, [activeTripId, threadsQuery.data, threads.length, ensureDefault]);

  const existing = useMemo(() => {
    if (threads.length === 0) return null;
    return threads.find((thread) => thread.isDefault) ?? threads[0];
  }, [threads]);

  const effectiveThreadId = existing?.id ?? null;
  const hasProvisioningError = tripsFailed || createPersonalTrip.isError || threadsQuery.isError || ensureDefault.isError;
  const threadStatus: ChatThreadStatus = hasProvisioningError
    ? "error"
    : effectiveThreadId ? "ready" : "preparing";

  const retryProvisioning = useCallback(() => {
    if (tripsFailed) {
      onRetryTrips();
      return;
    }
    if (!activeTripId) {
      provisionPersonalTrip();
      return;
    }
    autoProvisionAttemptedRef.current = false;
    if (threadsQuery.isError) {
      void threadsQuery.refetch();
      return;
    }
    void ensureDefault.mutateAsync().catch(() => {
      autoProvisionAttemptedRef.current = false;
    });
  }, [activeTripId, ensureDefault, onRetryTrips, provisionPersonalTrip, threadsQuery, tripsFailed]);

  const handleInvalidated = useCallback(() => {
    if (!activeTripId) return;
    void queryClient.invalidateQueries({ queryKey: tripKeys.threads(activeTripId) });
    autoProvisionAttemptedRef.current = false;
    void api
      .getOrCreateDefaultTripThread(activeTripId)
      .catch(() => {
        autoProvisionAttemptedRef.current = false;
      });
  }, [activeTripId, api, queryClient]);

  return (
    <div className="contents">
      {allTrips.length > 1 && activeTripId ? (
        <TripPickerChip
          label={pickerLabel}
          ariaLabel={switchTripAria}
          trips={allTrips}
          activeId={activeTrip?.id ?? activeTripId}
          onSelect={onSelectTrip}
        />
      ) : null}
      <TravelAgentChat
        open={open}
        onOpen={onOpen}
        onDismiss={onDismiss}
        threadId={effectiveThreadId}
        threadStatus={threadStatus}
        onRetryThread={retryProvisioning}
        onThreadInvalidated={handleInvalidated}
        {...(selectedPlace !== undefined ? { selectedPlace } : {})}
        {...(autoAskRequest !== undefined ? { autoAskRequest } : {})}
        {...(onAutoAskConsumed ? { onAutoAskConsumed } : {})}
        {...(onConversationText ? { onConversationText } : {})}
      />
    </div>
  );
}

function TripPickerChip({
  label,
  ariaLabel,
  trips,
  activeId,
  onSelect,
}: {
  label: string;
  ariaLabel: string;
  trips: TripSummary[];
  activeId: string;
  onSelect: (tripId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = trips.find((trip) => trip.id === activeId) ?? trips[0];
  if (!active) return null;

  return (
    <div className="pointer-events-auto fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-6 z-40 flex flex-col items-end gap-2">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs font-bold text-foreground backdrop-blur transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"
      >
        <span className="text-muted-foreground">{label}:</span>
        <span className="max-w-[12rem] truncate">{active.name}</span>
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <ul
          role="listbox"
          className="max-h-64 w-56 overflow-auto rounded-2xl border border-border bg-card p-1 shadow-lg"
        >
          {trips.map((trip) => (
            <li key={trip.id} role="option" aria-selected={trip.id === activeId}>
              <button
                type="button"
                onClick={() => {
                  onSelect(trip.id);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-sidebar/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="truncate">{trip.name}</span>
                {trip.id === activeId ? (
                  <span className="ml-2 size-1.5 shrink-0 rounded-full bg-sidebar" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
