"use client";

import { ArrowLeft, CheckSquare, Compass, HelpCircle, ListChecks, LoaderCircle, LocateFixed, LogIn, MapPin, RotateCw, Sparkles, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Map as MapLibreMap, Marker as MapLibreMarker, StyleSpecification } from "maplibre-gl";
import type { ConversationPlace } from "@/lib/api/contracts";
import { applyGeographyContrast, inspectGeographyLayers, OPEN_MAP_TILES_SOURCE, setGeographyLayerVisibility, type GeographyInspection, type GeographyVisibility } from "./map-geography-layers";
import { INITIAL_READINESS, mapReadinessStage, type MapReadiness, type MapStage } from "./map-readiness";

import { CountryBoundaryOverlay } from "./country-boundary-overlay";
import { cityKey, findMentionedCities, loadCityCatalog, type CatalogCity } from "./city-catalog";
import { GeographyLabelOverlay } from "./geography-label-overlay";
import { loadAdministrativeCenters, pinGranularityForZoom, pinSelectionForReference, type PinGranularity } from "./pin-selection";
import { solidifyGlobeStyle } from "./map-surface-style";
import { WanderBot } from "./wander-bot";
import { LocationIntroductionPanel } from "./location-introduction-panel";
import { ExploreChatHost, type TripConversationHandoff } from "./explore-chat-host";
import { useLocationIntroduction } from "@/lib/query/use-location-introduction";
import { useOptionalAuth } from "@/lib/auth/auth-provider";
import { useOptionalTravelApi } from "@/lib/query/provider";
import { Link } from "@/i18n/navigation";
import type { LocationReferenceResponse } from "@/lib/api/contracts";

export type ExploreDestination = {
  id: string;
  name: string;
  country: string;
  coordinates: [number, number];
  note: string;
  kind: "inspiration" | "geography";
  locationReference?: LocationReferenceResponse;
  locationReferenceStatus?: "loading" | "unavailable";
  cityKey?: string;
  cityName?: string;
  requestedPinGranularity?: PinGranularity;
  pinGranularity?: PinGranularity;
  pinKey?: string;
  manualPinSequence?: number;
  /**
   * Stable catalog `sourceId` returned by the server-side reference resolver.
   * `LocationIntroductionPanel` renders only when this is set.
   */
  stableSourceId?: string;
};
type Destination = ExploreDestination;

type ExploreState = "IDLE" | "SELECTED" | "TALKING" | "FLYING" | "EXPLORING";
type PinScope = "nearby" | "all";
type SourceEventDiagnostic = {
  sourceDataType: string | null;
  isSourceLoaded: boolean | null;
};

const SINGAPORE: [number, number] = [103.8198, 1.3521];
/**
 * Gap between retried location lookups. The endpoint allows 30 a minute, so
 * two seconds apart leaves room for the pins the traveller is creating by
 * hand while the backlog drains behind them.
 */
const RETRY_SPACING_MS = 2_000;

const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";
const NEARBY_RADIUS_KM = 50;
const DEFAULT_GEOGRAPHY_VISIBILITY: GeographyVisibility = { countries: true, regions: true, cities: true };

/**
 * Pointing devices, i.e. a desktop. Only there is the floor applied: a phone
 * has so little width beside the chat panel that clamping the zoom would push
 * the globe off screen rather than keep it whole.
 */
const DESKTOP_QUERY = "(min-width: 768px) and (pointer: fine)";

/**
 * Lowest zoom the desktop globe may reach.
 *
 * Below this the sphere is small enough to show both poles, and the raster
 * relief behind it is Web Mercator — it carries no tiles past roughly ±85°, so
 * the caps render as a couple of stretched lines and the ocean loses its
 * colour. The chat panel used to squeeze the globe to zoom 1 to make room for
 * itself, which is exactly when that shows.
 */
const DESKTOP_MIN_ZOOM = 2;

function isDesktopViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches;
}

async function loadGlobeStyle(): Promise<StyleSpecification> {
  const styleResponse = await fetch(MAP_STYLE_URL);
  if (!styleResponse.ok) throw new Error(`Map style request failed (${styleResponse.status})`);
  const style = await styleResponse.json() as StyleSpecification;
  return solidifyGlobeStyle({ ...style, projection: { type: "globe" } });
}

/**
 * Camera hand-off from the trip workspace's mini globe. When present the map
 * opens on that country instead of the default globe, and offers a way back
 * to the trip the viewer came from.
 */
/**
 * Reads a camera hand-off out of the query string, or `null` when there is not
 * one.
 *
 * The numbers are parsed only after the parameters are known to be present.
 * `Number(null)` is `0`, and zero is finite and a legal coordinate, so parsing
 * first made every visit without a hand-off look like a hand-off to
 * `[0, 0]` — the map opened in the Gulf of Guinea instead of Singapore, and the
 * globe never span, because the spin is skipped whenever a hand-off chose the
 * opening camera.
 */
function readFocusHandoff(params: URLSearchParams) {
  const rawLatitude = params.get("focusLat")?.trim();
  const rawLongitude = params.get("focusLng")?.trim();
  if (!rawLatitude || !rawLongitude) return null;

  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const tripId = params.get("fromTrip");
  const rawZoom = params.get("focusZoom")?.trim();
  const zoom = rawZoom ? Number(rawZoom) : Number.NaN;
  return {
    center: [longitude, latitude] as [number, number],
    zoom: Number.isFinite(zoom) ? Math.min(6, Math.max(1, zoom)) : 3.4,
    label: params.get("focusLabel"),
    // Only a well-formed trip id earns a back link; the value lands in a
    // route, so anything else is ignored rather than followed.
    tripId: tripId && /^[0-9a-f-]{36}$/i.test(tripId) ? tripId : null,
  };
}

/**
 * An explicit Trip → Home navigation may carry IDs only as a request to load
 * a conversation. `ExploreChatHost` still verifies ownership server-side via
 * the caller's own Trip thread list before it renders or submits a turn.
 */
export function readTripConversationHandoff(params: URLSearchParams): TripConversationHandoff | null {
  const tripId = params.get("fromTrip")?.trim();
  const threadId = params.get("thread")?.trim();
  return tripId && threadId && /^[0-9a-f-]{36}$/i.test(tripId) && /^[0-9a-f-]{36}$/i.test(threadId)
    ? { tripId, threadId }
    : null;
}

export function ExploreMapPage() {
  const auth = useOptionalAuth();
  const travelApi = useOptionalTravelApi();
  const searchParams = useSearchParams();
  // Initial gaze target: the globe. Recomputed on resize so the bot keeps
  // facing it rather than a stale coordinate.
  const [globeCenterPoint, setGlobeCenterPoint] = useState<{ x: number; y: number } | null>(null);
  const focusHandoff = useMemo(() => readFocusHandoff(new URLSearchParams(searchParams.toString())), [searchParams]);
  const tripConversationHandoff = useMemo(
    () => readTripConversationHandoff(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  // The handoff only chooses the opening camera. Reading it through a ref keeps
  // it out of the map effect's deps, so a later URL change cannot tear the map
  // down and rebuild it.
  const focusHandoffRef = useRef(focusHandoff);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapForBoundaryOverlay, setMapForBoundaryOverlay] = useState<MapLibreMap | null>(null);
  const inspirationMarkersRef = useRef(new Map<string, MapLibreMarker>());
  const inspirationsRef = useRef<Destination[]>([]);
  const inspirationSequenceRef = useRef(0);
  const chatCameraActiveRef = useRef(false);
  const chatOpenRef = useRef(false);
  const chatSelectedPinIdRef = useRef<string | null>(null);
  const preserveChatCameraOnCloseRef = useRef(false);
  const journeyTimersRef = useRef<number[]>([]);
  const noticeTimerRef = useRef<number | null>(null);
  const pendingChatCityKeysRef = useRef(new Set<string>());
  const spinAnimationRef = useRef<number | null>(null);
  const retriedLocationReferenceIdsRef = useRef(new Set<string>());
  const [readiness, setReadiness] = useState<MapReadiness>(INITIAL_READINESS);
  const readinessRef = useRef<MapReadiness>(INITIAL_READINESS);
  const styleLoadedRef = useRef(false);

  const t = useTranslations("explore");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const normalizedLocale: "en" | "zh" = locale === "zh" ? "zh" : "en";

  useEffect(() => {
    readinessRef.current = readiness;
  }, [readiness]);

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
  }, []);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [selected, setSelected] = useState<Destination | null>(null);
  const [inspirations, setInspirations] = useState<Destination[]>([]);
  const [checkedInspirationIds, setCheckedInspirationIds] = useState<Set<string>>(new Set());
  const [managePinsOpen, setManagePinsOpen] = useState(false);
  const [manageAnchorCoordinates, setManageAnchorCoordinates] = useState<[number, number] | null>(null);
  const introduction = useLocationIntroduction({
    sourceId: selected?.stableSourceId ?? null,
    locale: normalizedLocale,
  });
  const [pinScope, setPinScope] = useState<PinScope>("nearby");
  const [chatOpen, setChatOpen] = useState(false);
  const [exploreState, setExploreState] = useState<ExploreState>("IDLE");
  const [helpOpen, setHelpOpen] = useState(false);
  const [mapNotice, setMapNotice] = useState<string | null>(null);

  // The globe fills the map pane, so the pane's centre is where the bot looks
  // while it is settling. Re-measured on resize to avoid a stale target.
  useEffect(() => {
    const measureGlobeCentre = () => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      setGlobeCenterPoint({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    };
    measureGlobeCentre();
    window.addEventListener("resize", measureGlobeCentre);
    return () => window.removeEventListener("resize", measureGlobeCentre);
  }, []);

  useEffect(() => {
    inspirationMarkersRef.current.forEach((marker, id) => {
      const button = marker.getElement().querySelector<HTMLButtonElement>("button");
      if (!button) return;
      const isSelected = selected?.id === id;
      button.classList.toggle("wanderly-map-marker--selected", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
    });
  }, [selected]);

  const showMapNotice = useCallback((message: string) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setMapNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      setMapNotice(null);
      noticeTimerRef.current = null;
    }, 3200);
  }, []);

  const attachLocationReference = useCallback(async (inspiration: Destination) => {
    if (!travelApi) return;
    const loading = { ...inspiration, locationReferenceStatus: "loading" as const };
    inspirationsRef.current = inspirationsRef.current.map((item) => item.id === inspiration.id ? loading : item);
    setInspirations(inspirationsRef.current);
    setSelected((current) => current?.id === inspiration.id ? loading : current);
    try {
      const locationReference = await travelApi.getLocationReference({
        latitude: inspiration.coordinates[1], longitude: inspiration.coordinates[0],
        // The reference names the country and region shown beside the pin, so
        // a Chinese reader was being handed "Inner Mongol · China" next to a
        // map already labelled 内蒙古自治区.
        language: locale,
      });
      // Open water with nothing to reach: the reverse lookup names no place.
      // Rather than leave a nameless pin bobbing in the ocean, take the pin
      // back and let 派蒙 wave the traveller off the edge of the world.
      if (locationReference.outcome === "NO_REFERENCE") {
        inspirationMarkersRef.current.get(inspiration.id)?.remove();
        inspirationMarkersRef.current.delete(inspiration.id);
        retriedLocationReferenceIdsRef.current.delete(inspiration.id);
        inspirationsRef.current = inspirationsRef.current.filter((item) => item.id !== inspiration.id);
        setInspirations(inspirationsRef.current);
        setSelected((current) => current?.id === inspiration.id ? null : current);
        showMapNotice(t("oceanExploreLater"));
        return;
      }
      const centers = locationReference.outcome === "REFERENCE"
        ? await loadAdministrativeCenters(locale).catch(() => [])
        : [];
      const selection = locationReference.outcome === "REFERENCE"
        ? pinSelectionForReference(
            inspiration.requestedPinGranularity ?? "city",
            locationReference,
            inspiration.coordinates,
            centers,
          )
        : null;
      const referencedCityCenter: [number, number] | null = locationReference.outcome === "REFERENCE" && locationReference.nearestCityCoordinates
        ? [locationReference.nearestCityCoordinates.longitude, locationReference.nearestCityCoordinates.latitude]
        : null;
      const duplicate = selection
        ? inspirationsRef.current.find((item) => item.id !== inspiration.id && (
            item.pinKey === selection.key
            || (selection.granularity === "city" && selection.cityName && referencedCityCenter
              ? isSameCity(item, selection.cityName, referencedCityCenter)
              : false)
          ))
        : undefined;
      if (duplicate) {
        const duplicateIsNewer = (duplicate.manualPinSequence ?? Number.NEGATIVE_INFINITY)
          > (inspiration.manualPinSequence ?? Number.NEGATIVE_INFINITY);
        if (duplicateIsNewer) {
          inspirationMarkersRef.current.get(inspiration.id)?.remove();
          inspirationMarkersRef.current.delete(inspiration.id);
          retriedLocationReferenceIdsRef.current.delete(inspiration.id);
          inspirationsRef.current = inspirationsRef.current.filter((item) => item.id !== inspiration.id);
          setInspirations(inspirationsRef.current);
          setSelected((current) => current?.id === inspiration.id ? duplicate : current);
          showMapNotice(t("pinUpdated", { name: selection?.name ?? duplicate.name }));
          return;
        }
        inspirationMarkersRef.current.get(duplicate.id)?.remove();
        inspirationMarkersRef.current.delete(duplicate.id);
        retriedLocationReferenceIdsRef.current.delete(duplicate.id);
        inspirationsRef.current = inspirationsRef.current.filter((item) => item.id !== duplicate.id);
        showMapNotice(t("pinUpdated", { name: selection?.name ?? duplicate.name }));
      }
      const next = locationReference.outcome === "REFERENCE" && selection
        ? {
            ...inspiration,
            name: selection.name,
            country: referenceContext(locationReference, selection.granularity),
            note: t("locationReferenceNote"),
            coordinates: selection.coordinates,
            pinKey: selection.key,
            pinGranularity: selection.granularity,
            cityKey: selection.granularity === "city" ? selection.key : undefined,
            cityName: selection.cityName,
            locationReference,
            locationReferenceStatus: undefined,
            stableSourceId: locationReference.introductionSourceId ?? undefined,
          }
        : { ...inspiration, locationReference, locationReferenceStatus: undefined };
      inspirationsRef.current = inspirationsRef.current.map((item) => item.id === inspiration.id ? next : item);
      setInspirations(inspirationsRef.current);
      setSelected((current) => current?.id === inspiration.id || current?.id === duplicate?.id ? next : current);
      const markerButton = inspirationMarkersRef.current.get(inspiration.id)?.getElement().querySelector("button");
      inspirationMarkersRef.current.get(inspiration.id)?.setLngLat(next.coordinates);
      if (markerButton) {
        setMarkerLabel(markerButton, next.name);
        markerButton.setAttribute("aria-label", t("markerOpenAria", { name: next.name }));
      }
    } catch {
      const unavailable = { ...inspiration, locationReferenceStatus: "unavailable" as const };
      inspirationsRef.current = inspirationsRef.current.map((item) => item.id === inspiration.id ? unavailable : item);
      setInspirations(inspirationsRef.current);
      setSelected((current) => current?.id === inspiration.id ? unavailable : current);
    }
  }, [locale, showMapNotice, t, travelApi]);

  /**
   * Retries unlabelled pins one at a time.
   *
   * This used to fire every outstanding pin at once, on mount and again on
   * every window focus. The endpoint allows thirty requests a minute, so a
   * board with more pins than that answered 429 to the rest — and the retry
   * meant to heal them re-sent the whole backlog in a single tick, keeping
   * them unlabelled for good. A traveller with 47 pins saw "Pinned place 31"
   * upward stay nameless however often they came back.
   *
   * Draining one at a time keeps the burst under the limit and lets the
   * backlog finish across a few passes instead of failing wholesale.
   */
  useEffect(() => {
    if (!travelApi) return;
    let draining = false;
    let stopped = false;
    let timer: number | undefined;

    const drain = async () => {
      if (draining || stopped) return;
      draining = true;
      try {
        for (const inspiration of inspirationsRef.current.filter(
          (item) => item.locationReferenceStatus === "unavailable",
        )) {
          if (stopped) return;
          if (retriedLocationReferenceIdsRef.current.has(inspiration.id)) continue;
          retriedLocationReferenceIdsRef.current.add(inspiration.id);
          await attachLocationReference(inspiration);
          // Paced rather than parallel: the point is to stay under the
          // window, not to finish fastest.
          await new Promise((resolve) => { timer = window.setTimeout(resolve, RETRY_SPACING_MS); });
        }
      } finally {
        draining = false;
      }
    };

    const initialRetry = window.setTimeout(() => void drain(), 750);
    const onFocus = () => void drain();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearTimeout(initialRetry);
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [attachLocationReference, travelApi]);

  const clearJourneyTimers = useCallback(() => {
    journeyTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    journeyTimersRef.current = [];
  }, []);

  const selectDestination = useCallback((destination: Destination) => {
    clearJourneyTimers();
    stopGlobeSpin(spinAnimationRef);
    setSelected(destination);
    setExploreState("SELECTED");
    if (chatOpenRef.current) {
      if (chatSelectedPinIdRef.current === destination.id) {
        preserveChatCameraOnCloseRef.current = true;
        chatOpenRef.current = false;
        chatSelectedPinIdRef.current = null;
        setChatOpen(false);
      } else {
        chatSelectedPinIdRef.current = destination.id;
      }
      return;
    }
    mapRef.current?.flyTo({ center: destination.coordinates, zoom: 4.8, duration: reducedMotion() ? 0 : 1600 });
  }, [clearJourneyTimers]);

  const deleteInspirations = useCallback(
    (ids: Iterable<string>) => {
      const idsToDelete = new Set(ids);
      if (idsToDelete.size === 0) return;

      idsToDelete.forEach((id) => {
        inspirationMarkersRef.current.get(id)?.remove();
        inspirationMarkersRef.current.delete(id);
        retriedLocationReferenceIdsRef.current.delete(id);
      });
      inspirationsRef.current = inspirationsRef.current.filter((inspiration) => !idsToDelete.has(inspiration.id));
      if (inspirationsRef.current.length === 0) inspirationSequenceRef.current = 0;
      setInspirations(inspirationsRef.current);
      setCheckedInspirationIds((current) => {
        const next = new Set(current);
        idsToDelete.forEach((id) => next.delete(id));
        return next;
      });
      setSelected((current) => {
        if (current && idsToDelete.has(current.id)) {
          clearJourneyTimers();
          setExploreState("IDLE");
          return null;
        }
        return current;
      });
    },
    [clearJourneyTimers],
  );

  const pinCatalogCity = useCallback(async (city: CatalogCity, skipCamera = false) => {
    const map = mapRef.current;
    if (!map) return;
    const duplicate = inspirationsRef.current.find((item) => isSameCity(item, city.name, city.coordinates));
    if (duplicate) {
      if (!skipCamera) focusChatOnDestination(duplicate, setSelected, setExploreState, chatSelectedPinIdRef);
      return;
    }
    if (pendingChatCityKeysRef.current.has(city.key)) return;
    pendingChatCityKeysRef.current.add(city.key);
    try {
      const maplibregl = await import("maplibre-gl");
      if (mapRef.current !== map) return;
      const duplicateAfterLoad = inspirationsRef.current.find((item) => isSameCity(item, city.name, city.coordinates));
      if (duplicateAfterLoad) {
        focusChatOnDestination(duplicateAfterLoad, setSelected, setExploreState, chatSelectedPinIdRef);
        return;
      }

      inspirationSequenceRef.current += 1;
      const inspiration: Destination = {
        ...inspirationAt(
          `inspiration-${inspirationSequenceRef.current}`,
          inspirationSequenceRef.current,
          city.coordinates,
        ),
        name: city.localizedName,
        country: t("chatMentionedCityContext"),
        note: t("chatMentionedCityNote"),
        cityKey: cityKey(null, city.name),
        cityName: city.name,
        requestedPinGranularity: "city",
        pinGranularity: "city",
        pinKey: cityKey(null, city.name),
      };
      const { anchor, button } = markerElement(inspiration.name);
      button.setAttribute("aria-label", t("markerOpenAria", { name: inspiration.name }));
      button.addEventListener("click", (markerEvent) => {
        markerEvent.stopPropagation();
        const current = inspirationsRef.current.find((item) => item.id === inspiration.id) ?? inspiration;
        selectDestination(current);
      });
      const marker = new maplibregl.Marker({ element: anchor, anchor: "bottom" })
        .setLngLat(inspiration.coordinates)
        .addTo(map);
      inspirationMarkersRef.current.set(inspiration.id, marker);
      inspirationsRef.current = [...inspirationsRef.current, inspiration];
      setInspirations(inspirationsRef.current);
      if (!skipCamera) {
        selectDestination(inspiration);
        showMapNotice(t("cityPinnedFromChat", { name: inspiration.name }));
      }
    } finally {
      pendingChatCityKeysRef.current.delete(city.key);
    }
  }, [selectDestination, showMapNotice, t]);

  const handleConversationText = useCallback((textValue: string) => {
    if (!textValue.trim()) return;
    void loadCityCatalog(locale).then(async (cities) => {
      const mentioned = findMentionedCities(textValue, cities);
      if (mentioned.length === 0) return;
      if (mentioned.length === 1) {
        void pinCatalogCity(mentioned[0]);
        return;
      }
      await Promise.all(mentioned.map((city) => pinCatalogCity(city, true)));
      const map = mapRef.current;
      if (!map) return;
      const maplibregl = await import("maplibre-gl");
      const bounds = new maplibregl.LngLatBounds();
      mentioned.forEach((city) => bounds.extend(city.coordinates));
      const camera = map.cameraForBounds(bounds, { padding: 80 });
      if (camera && (camera.zoom ?? 0) >= 2.25) {
        stopGlobeSpin(spinAnimationRef);
        map.fitBounds(bounds, { padding: 80, maxZoom: 6, duration: reducedMotion() ? 0 : 1600 });
      } else {
        stopGlobeSpin(spinAnimationRef);
        map.flyTo({ center: SINGAPORE, zoom: 2.25, duration: reducedMotion() ? 0 : 1400 });
        if (!reducedMotion()) {
          map.once("moveend", () => startGlobeSpin(map, spinAnimationRef));
        }
      }
    });
  }, [locale, pinCatalogCity]);

  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    const inspirationMarkers = inspirationMarkersRef.current;
    const retriedLocationReferenceIds = retriedLocationReferenceIdsRef.current;
    const sourceEvents: SourceEventDiagnostic[] = [];
    const mapErrors: string[] = [];

    function transitionToUnavailable(map: MapLibreMap | null, reason: "timeout" | "error" | "exception") {
      const next: MapReadiness = { kind: "unavailable-network", reason, styleUrl: MAP_STYLE_URL };
      readinessRef.current = next;
      setReadiness(next);
      if (process.env.NODE_ENV !== "production") {
        const existing = (window as unknown as { __wanderlyMap?: Record<string, unknown> }).__wanderlyMap;
        (window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap = {
          ...(existing ?? {}),
          map: map ?? null,
          get readiness() {
            return readinessRef.current;
          },
          missingLayers: [] as readonly string[],
          sourcePresent: false,
          styleUrl: MAP_STYLE_URL,
          get sourceEvents(): readonly SourceEventDiagnostic[] {
            return [...sourceEvents];
          },
          get mapErrors(): readonly string[] {
            return [...mapErrors];
          },
          get stage(): MapStage {
            return mapReadinessStage(readinessRef.current, styleLoadedRef.current);
          },
          retry: () => retryMap(),
        };
      }
    }

    function attachDevHook(map: MapLibreMap, inspection: GeographyInspection) {
      if (process.env.NODE_ENV === "production") return;
      (window as unknown as { __wanderlyMap?: unknown }).__wanderlyMap = {
        map,
        get readiness() {
          return readinessRef.current;
        },
        missingLayers: inspection.missingLayers,
        sourcePresent: inspection.sourcePresent,
        styleUrl: MAP_STYLE_URL,
        get sourceEvents(): readonly SourceEventDiagnostic[] {
          return [...sourceEvents];
        },
        get mapErrors(): readonly string[] {
          return [...mapErrors];
        },
        get stage(): MapStage {
          return mapReadinessStage(readinessRef.current, styleLoadedRef.current);
        },
        retry: () => retryMap(),
      };
    }

    function finalizeReadiness(map: MapLibreMap, inspection: GeographyInspection) {
      if (cancelled) return;
      const next: MapReadiness = inspection.supported
        ? { kind: "ready-supported", styleUrl: MAP_STYLE_URL }
        : !inspection.sourcePresent
          ? { kind: "ready-style-unsupported-source", styleUrl: MAP_STYLE_URL, sourceId: OPEN_MAP_TILES_SOURCE }
          : {
              kind: "ready-style-missing-layers",
              styleUrl: MAP_STYLE_URL,
              sourceId: OPEN_MAP_TILES_SOURCE,
              missingLayers: inspection.missingLayers,
            };
      // The country fallback is independent of Liberty's optional layer IDs.
      // It must initialize even when a custom style is only partially compatible.
      applyGeographyContrast(map);
      setGeographyLayerVisibility(map, DEFAULT_GEOGRAPHY_VISIBILITY);
      attachDevHook(map, inspection);
      readinessRef.current = next;
      setReadiness(next);
    }

    function onSourceData(event: { sourceId?: string; sourceDataType?: string; isSourceLoaded?: boolean }) {
      if (event.sourceId !== OPEN_MAP_TILES_SOURCE) return;
      sourceEvents.push({
        sourceDataType: event.sourceDataType ?? null,
        isSourceLoaded: event.isSourceLoaded ?? null,
      });
      if (sourceEvents.length > 20) sourceEvents.shift();
      if (event.sourceDataType === "metadata") {
        // MapLibre caches style metadata per-source; a metadata refresh usually
        // means new tiles became available. Ask the renderer to redraw so the
        // globe reflects them without waiting for the next viewport change.
        mapRef.current?.redraw();
      }
    }

    const loadTimeout = window.setTimeout(() => {
      if (!cancelled && !loaded) {
        transitionToUnavailable(null, "timeout");
      }
    }, 12_000);

    async function initializeMap() {
      if (!containerRef.current || mapRef.current) return;

      try {
        const [maplibregl, globeStyle] = await Promise.all([import("maplibre-gl"), loadGlobeStyle()]);
        if (cancelled || !containerRef.current) return;

        const map = new maplibregl.Map({
          container: containerRef.current,
          style: globeStyle,
          center: focusHandoffRef.current?.center ?? SINGAPORE,
          zoom: focusHandoffRef.current?.zoom ?? 2.25,
          // Applies to every camera move, including the automatic ones: MapLibre
          // clamps `easeTo`/`flyTo` to it, so the chat panel can no longer zoom
          // out past the point where the globe stops looking like one.
          minZoom: isDesktopViewport() ? DESKTOP_MIN_ZOOM : undefined,
          attributionControl: false,
        });
        mapRef.current = map;
        setMapForBoundaryOverlay(map);
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
        map.on("sourcedata", onSourceData);
        const stopSpin = () => stopGlobeSpin(spinAnimationRef);
        map.on("mousedown", stopSpin);
        map.on("touchstart", stopSpin);
        map.on("wheel", stopSpin);

        map.once("style.load", () => {
          try {
            loaded = true;
            styleLoadedRef.current = true;
            window.clearTimeout(loadTimeout);
            map.addControl(new maplibregl.AttributionControl({
              compact: window.innerWidth < 640,
              customAttribution: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a> · <a href="https://help.aliyun.com/zh/datav/datav-7-0/user-guide/china-state-border-4-0" target="_blank" rel="noopener noreferrer">China maritime line (local snapshot)</a> · <a href="https://openrouteservice.org/" target="_blank" rel="noopener noreferrer">© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors</a>',
            }), "bottom-right");
            finalizeReadiness(map, inspectGeographyLayers(map, MAP_STYLE_URL));
            if (!cancelled && !reducedMotion() && !focusHandoffRef.current) startGlobeSpin(map, spinAnimationRef);
            window.queueMicrotask(() => {
              if (!cancelled) configureMapAttribution(containerRef.current);
            });
          } catch {
            if (!cancelled) transitionToUnavailable(map, "exception");
          }
        });

        const onMapError = (event: { error?: { message?: string } }) => {
          if (event.error?.message) {
            mapErrors.push(event.error.message);
            if (mapErrors.length > 20) mapErrors.shift();
          }
          if (!loaded && !cancelled) {
            transitionToUnavailable(map, "error");
          }
        };
        map.on("error", onMapError);

        map.on("click", (event) => {
          inspirationSequenceRef.current += 1;
          const inspiration = inspirationAt(
            `inspiration-${inspirationSequenceRef.current}`,
            inspirationSequenceRef.current,
            [event.lngLat.lng, event.lngLat.lat],
            pinGranularityForZoom(map.getZoom()),
          );
          const { anchor, button } = markerElement(inspiration.name);
          button.setAttribute("aria-label", t("markerOpenAria", { name: inspiration.name }));
          button.addEventListener("click", (markerEvent) => {
            markerEvent.stopPropagation();
            const current = inspirationsRef.current.find((item) => item.id === inspiration.id) ?? inspiration;
            selectDestination(current);
          });
          const marker = new maplibregl.Marker({ element: anchor, anchor: "bottom" })
            .setLngLat(inspiration.coordinates)
            .addTo(map);
          inspirationMarkers.set(inspiration.id, marker);
          inspirationsRef.current = [...inspirationsRef.current, inspiration];
          setInspirations(inspirationsRef.current);
          selectDestination(inspiration);
          void attachLocationReference(inspiration);
        });

        const syncInspirationPositions = () => {
          inspirationsRef.current.forEach((inspiration) => {
            inspirationMarkers.get(inspiration.id)?.setLngLat(inspiration.coordinates);
          });
        };
        map.on("move", syncInspirationPositions);

      } catch {
        if (!cancelled) {
          window.clearTimeout(loadTimeout);
          transitionToUnavailable(null, "exception");
        }
      }
    }

    void initializeMap();

    return () => {
      cancelled = true;
      window.clearTimeout(loadTimeout);
      stopGlobeSpin(spinAnimationRef);
      mapRef.current?.off("sourcedata", onSourceData);
      clearJourneyTimers();
      inspirationMarkers.forEach((marker) => marker.remove());
      inspirationMarkers.clear();
      inspirationsRef.current = [];
      inspirationSequenceRef.current = 0;
      retriedLocationReferenceIds.clear();
      styleLoadedRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
      setMapForBoundaryOverlay(null);
    };
  }, [attachLocationReference, clearJourneyTimers, locale, mapAttempt, selectDestination, t]);

  // Dragging a window between a phone-sized pane and a desktop one has to move
  // the floor with it, or the globe stays clamped where it should not be.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(DESKTOP_QUERY);
    const apply = () => {
      const map = mapRef.current;
      // Guarded because the floor is an enhancement, not a requirement: a map
      // implementation without it should still render rather than throw.
      if (typeof map?.setMinZoom !== "function") return;
      map.setMinZoom(media.matches ? DESKTOP_MIN_ZOOM : undefined);
    };
    apply();
    // Older Safari, and the jsdom stub, expose only the deprecated
    // `addListener`. Feature-detect rather than assume the modern one.
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
    media.addListener?.(apply);
    return () => media.removeListener?.(apply);
  }, [readiness.kind]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || readiness.kind !== "ready-supported") return;

    if (!chatOpen) {
      if (chatCameraActiveRef.current) {
        if (preserveChatCameraOnCloseRef.current) {
          preserveChatCameraOnCloseRef.current = false;
          chatCameraActiveRef.current = false;
          return;
        }
        map.easeTo({ padding: { top: 0, right: 0, bottom: 0, left: 0 }, duration: reducedMotion() ? 0 : 450 });
        chatCameraActiveRef.current = false;
      }
      return;
    }

    const initialZoom = map.getZoom();
    const adjustCameraForChat = (duration: number) => {
      const currentCenter = map.getCenter();
      const isPortrait = window.matchMedia("(orientation: portrait)").matches;

      if (isPortrait) {
        map.easeTo({
          center: selected ? selected.coordinates : [currentCenter.lng, currentCenter.lat],
          zoom: selected ? Math.max(initialZoom, 5.4) : initialZoom + Math.log2(0.8),
          padding: { top: 0, right: 0, bottom: Math.round(window.innerHeight * 0.6) + 24, left: 0 },
          duration,
        });
      } else {
        const mapWidth = containerRef.current?.clientWidth || 1024;
        const mapHeight = containerRef.current?.clientHeight || window.innerHeight;
        const dialogWidth = document.querySelector<HTMLElement>('[aria-label="Wanderly Agent conversation"]')?.offsetWidth || mapWidth * 0.4;
        const rightPadding = Math.min(dialogWidth + 24, Math.max(0, mapWidth - 120));
        const visibleWidth = Math.max(120, mapWidth - rightPadding);
        const shortEdge = Math.min(mapWidth, mapHeight);
        const comfortableGlobeDiameter = shortEdge * 0.72;
        const globeScale = visibleWidth >= comfortableGlobeDiameter
          ? 1
          : Math.min(1, (visibleWidth * 0.9) / (shortEdge * 0.9));

        map.easeTo({
          center: selected ? selected.coordinates : [currentCenter.lng, currentCenter.lat],
          zoom: selected ? Math.max(initialZoom, 5.4) : initialZoom + Math.log2(globeScale),
          padding: { top: 0, right: rightPadding, bottom: 0, left: 0 },
          duration,
        });
      }

      chatCameraActiveRef.current = true;
    };

    adjustCameraForChat(reducedMotion() ? 0 : 650);
    let resizeTimer: number | undefined;
    const handleResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => adjustCameraForChat(reducedMotion() ? 0 : 350), 120);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.clearTimeout(resizeTimer);
    };
  }, [chatOpen, readiness.kind, selected]);

  function recenter() {
    clearJourneyTimers();
    stopGlobeSpin(spinAnimationRef);
    mapRef.current?.flyTo({ center: SINGAPORE, zoom: 2.25, duration: reducedMotion() ? 0 : 1400 });
    setSelected(null);
    setExploreState("IDLE");
  }

  function startExploring() {
    if (!selected) return;
    clearJourneyTimers();
    // Opening chat from the map never persists a trip or sends a message.
    // The user's first explicit Send is the only provisioning trigger.
    setExploreState("EXPLORING");
    openChat();
  }

  function retryMap() {
    readinessRef.current = INITIAL_READINESS;
    setReadiness(INITIAL_READINESS);
    setMapAttempt((attempt) => attempt + 1);
  }

  function openPinManager() {
    if (!selected || selected.kind !== "inspiration") return;
    setManageAnchorCoordinates(selected.coordinates);
    setPinScope("nearby");
    setCheckedInspirationIds(new Set());
    setManagePinsOpen(true);
  }

  function toggleInspiration(id: string) {
    setCheckedInspirationIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openChat() {
    chatOpenRef.current = true;
    chatSelectedPinIdRef.current = null;
    setChatOpen(true);
  }

  function dismissChat() {
    clearJourneyTimers();
    chatOpenRef.current = false;
    chatSelectedPinIdRef.current = null;
    preserveChatCameraOnCloseRef.current = false;
    setChatOpen(false);
    setSelected(null);
    setExploreState("IDLE");
  }

  const managedInspirations = pinScope === "all" || !manageAnchorCoordinates
    ? inspirations
    : inspirations.filter((inspiration) => distanceInKm(inspiration.coordinates, manageAnchorCoordinates) <= NEARBY_RADIUS_KM);

  const nearbyDistance = useMemo(() => {
    const formatter = new Intl.NumberFormat(locale || "en", { style: "unit", unit: "kilometer", unitDisplay: "short" });
    return formatter.format(NEARBY_RADIUS_KM);
  }, [locale]);

  return (
    <main data-drawer-open={selected && !chatOpen ? "true" : "false"} className="wanderly-explore-map wanderly-cosmos relative isolate h-[calc(100dvh-62px)] min-h-[620px] overflow-hidden sm:h-screen">
      {/*
        * Space, with the stars painted onto it rather than over the scene. The
        * globe canvas is transparent around the sphere, so stars on this layer
        * show through beside the planet and are hidden behind it — which is
        * where stars belong. Carried by the page instead, they landed on the
        * globe itself and read as specks on the map.
        */}
      <div className="wanderly-starfield absolute inset-0 bg-[var(--w-space)]" aria-hidden="true" />
      <div className="absolute inset-0">
        <div ref={containerRef} className="size-full" aria-label={t("globeAriaLabel")} />
      </div>
      <CountryBoundaryOverlay map={mapForBoundaryOverlay} visible />
      <GeographyLabelOverlay map={mapForBoundaryOverlay} locale={locale} visibility={DEFAULT_GEOGRAPHY_VISIBILITY} />

      {readiness.kind === "loading" ? (
        <div className="pointer-events-none absolute inset-0 z-[4] grid place-items-center" role="status">
          <span data-wanderly-avoid className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold wanderly-cosmos-panel wanderly-r-sm">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> {tCommon("loadingGlobe")}
          </span>
        </div>
      ) : null}

      {mapNotice ? (
        <div role="status" aria-live="polite" data-wanderly-avoid className="pointer-events-none absolute left-1/2 top-20 z-[60] -translate-x-1/2 px-4 py-2 text-center text-sm font-bold wanderly-cosmos-panel wanderly-r-sm sm:top-24">
          {mapNotice}
        </div>
      ) : null}

      {/* Draggable companion. It positions itself, so no wrapper here. */}
      <WanderBot
        lookAt={globeCenterPoint}
        perchSelector='[data-wanderly-perch="composer"]'
        boundsSelector=".wanderly-explore-map"
        obstructed={chatOpen}
        speechPlace={selected?.name ?? null}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-4 p-4 sm:pb-6 sm:pl-[104px] sm:pr-6 sm:pt-6">
        <div data-wanderly-avoid className="pointer-events-auto flex flex-col items-start gap-2">
          {tripConversationHandoff ? (
            <Link
              href={`/trips/${tripConversationHandoff.tripId}?thread=${tripConversationHandoff.threadId}` as "/trips/[tripId]"}
              className="inline-flex min-h-10 items-center gap-1.5 px-3 text-xs font-extrabold wanderly-cosmos-control wanderly-r-sm wanderly-press"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              {t("backToTrip")}
            </Link>
          ) : null}
          <div className="px-4 py-3 wanderly-cosmos-panel wanderly-r-lg">
          <p className="font-black tracking-[-0.035em]">{tCommon("brandTagline")}</p>
          <p className="mt-0.5 text-xs opacity-85">{focusHandoff?.label ?? t("startingFrom")}</p>
          </div>
        </div>
        <div data-wanderly-avoid className="pointer-events-auto flex gap-2">
          <button type="button" onClick={recenter} aria-label={t("recenterAriaLabel")} title={t("recenterTitle")} className="grid size-12 place-items-center wanderly-cosmos-control wanderly-r-sm wanderly-press">
            <LocateFixed aria-hidden="true" className="size-5" />
          </button>
          <button type="button" onClick={() => setHelpOpen((open) => !open)} aria-label={t("helpAriaLabel")} aria-expanded={helpOpen} title={t("helpTitle")} className="grid size-12 place-items-center rounded-[16px] bg-sidebar/95 text-white shadow-lg backdrop-blur focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/50">
            <HelpCircle aria-hidden="true" className="size-5" />
          </button>
          {auth?.status !== "SIGNED_IN" ? (
            <Link href="/login" aria-label={t("loginAriaLabel")} title={t("loginTitle")} className="grid h-12 w-24 place-items-center text-sm font-bold wanderly-cosmos-control wanderly-r-sm wanderly-press">
              <span className="flex items-center gap-1.5">
                <LogIn aria-hidden="true" className="size-4" />
                {t("loginButton")}
              </span>
            </Link>
          ) : null}
        </div>
      </header>

      {helpOpen ? (
        <aside data-wanderly-avoid className="absolute right-4 top-20 z-30 w-[min(320px,calc(100%-2rem))] p-4 text-sm leading-6 wanderly-cosmos-panel wanderly-r-lg sm:right-6 sm:top-24">
          <p className="font-bold">{t("helpHeading")}</p>
          <p className="mt-1 opacity-85">{t("helpBody")}</p>
        </aside>
      ) : null}

      {readiness.kind === "unavailable-network" ? (
        <section className="absolute inset-0 z-[5] grid place-items-center bg-[radial-gradient(circle_at_center,#d7edb0_0_19%,transparent_20%),radial-gradient(circle_at_25%_38%,#e8cc89_0_11%,transparent_12%),#82cad8] p-6 text-center">
          <div className="max-w-md rounded-[24px] bg-card/95 p-7 shadow-2xl backdrop-blur">
            <Compass aria-hidden="true" className="mx-auto size-9 text-primary" />
            <h1 className="mt-4 text-2xl font-bold tracking-[-0.04em]">{t("unavailableHeading")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("unavailableBody")}</p>
            <button type="button" onClick={retryMap} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-[14px] bg-primary px-4 font-bold text-primary-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
              <RotateCw aria-hidden="true" className="size-4" /> {t("retryMap")}
            </button>
          </div>
        </section>
      ) : null}

      {managePinsOpen ? (
        <section data-wanderly-avoid className="absolute bottom-20 left-4 z-20 block w-[min(360px,calc(100%-2rem))] p-4 wanderly-cosmos-panel wanderly-r-lg landscape:bottom-6 landscape:left-6 sm:landscape:left-[104px]">
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-primary">
                  <Sparkles aria-hidden="true" className="size-4" />
                  <p className="text-[11px] font-black uppercase tracking-[0.14em]">{t("managePinsKicker")}</p>
                </div>
                <h1 className="mt-1 text-xl font-bold tracking-[-0.045em]">{t("managePinsTitle")}</h1>
              </div>
              <button type="button" onClick={() => { setManagePinsOpen(false); setCheckedInspirationIds(new Set()); }} aria-label={t("managePinsCloseAriaLabel")} className="grid size-9 place-items-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t("managePinsBody")}</p>
            <div className="mt-3 grid grid-cols-2 rounded-[12px] bg-muted p-1" aria-label={t("manageScopeLabel")}>
              <button type="button" aria-pressed={pinScope === "nearby"} onClick={() => setPinScope("nearby")} className="min-h-9 rounded-[9px] px-2 text-xs font-bold aria-pressed:bg-card aria-pressed:text-primary aria-pressed:shadow-sm">
                {t("manageScopeNearby", { distance: nearbyDistance })}
              </button>
              <button type="button" aria-pressed={pinScope === "all"} onClick={() => setPinScope("all")} className="min-h-9 rounded-[9px] px-2 text-xs font-bold aria-pressed:bg-card aria-pressed:text-primary aria-pressed:shadow-sm">
                {t("manageScopeAll", { count: inspirations.length })}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t("manageScopeHint", { distance: nearbyDistance })}</p>
            <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto pr-1" role="list" aria-label={t("pinListAriaLabel")}>
              {managedInspirations.map((inspiration) => (
                <div key={inspiration.id} role="listitem" className={`flex items-center gap-1.5 rounded-[11px] border p-1.5 transition ${selected?.id === inspiration.id ? "border-primary bg-secondary/60" : "bg-background/75"}`}>
                  <input type="checkbox" checked={checkedInspirationIds.has(inspiration.id)} onChange={() => toggleInspiration(inspiration.id)} aria-label={t("pinCheckboxAriaLabel", { name: inspiration.name })} className="size-4 shrink-0 accent-[var(--primary)]" />
                  <button type="button" onClick={() => selectDestination(inspiration)} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
                    <span className="block truncate text-xs font-bold">{inspiration.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{inspiration.country}</span>
                  </button>
                </div>
              ))}
            </div>
            <button type="button" disabled={checkedInspirationIds.size === 0} onClick={() => deleteInspirations(checkedInspirationIds)} className="mt-2.5 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-[12px] bg-destructive px-3 text-xs font-bold text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-destructive/25">
              <CheckSquare aria-hidden="true" className="size-4" />
              {checkedInspirationIds.size > 0 ? t("deleteSelectedWithCount", { count: checkedInspirationIds.size }) : t("deleteSelected")}
            </button>
          </>
        </section>
      ) : null}

      {selected && !managePinsOpen && !chatOpen ? (
        <aside data-wanderly-avoid className="absolute inset-x-3 bottom-3 z-30 max-h-[70dvh] overflow-y-auto bg-card p-5 pb-24 text-[var(--w-ink)] wanderly-edge wanderly-r-lg wanderly-shadow-lg sm:left-[94px] sm:right-3 landscape:inset-x-auto landscape:bottom-auto landscape:right-6 landscape:top-28 landscape:w-[min(360px,calc(100%-2rem))] landscape:pb-5">
          <button type="button" onClick={() => { clearJourneyTimers(); setSelected(null); setExploreState("IDLE"); }} aria-label={t("drawerCloseAriaLabel")} className="absolute right-4 top-4 grid size-9 place-items-center bg-[var(--w-fog)] wanderly-edge-thin wanderly-r-xs wanderly-shadow-xs wanderly-press">
            <X aria-hidden="true" className="size-4" />
          </button>
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--w-ink)] wanderly-underline">{stateLabel(exploreState, t)}</p>
          <h2 className="mt-2 pr-9 text-3xl font-bold tracking-[-0.05em] text-[var(--w-ink)]" aria-live="polite">
            {selected.locationReferenceStatus === "loading" ? t("resolvingLocation") : selected.name}
          </h2>
          <p className="font-semibold text-[var(--w-muted)]">{selected.country}</p>
          <p className="mt-3 inline-flex bg-[var(--w-mist)] px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">
            {selected.kind === "geography"
                ? t("drawerKindGeography")
                : t("drawerKindInspiration")}
          </p>
          <p className="mt-4 text-sm leading-6 text-[var(--w-muted)]">{selected.note}</p>
          {selected.locationReference?.outcome === "REFERENCE" ? (
            <div className="mt-3 text-xs leading-5 text-muted-foreground">
              <p>{t("locationReference", {
                country: selected.locationReference.country,
                region: selected.locationReference.admin1 ?? t("locationReferenceNoRegion"),
                city: selected.locationReference.nearestCity ?? t("locationReferenceNoCity"),
              })}</p>
              <p className="mt-1">
                {t("locationReferenceDataPrefix")} <a className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a>{" · "}<a className="underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" href="https://www.geonames.org/" target="_blank" rel="noreferrer">GeoNames</a>
              </p>
            </div>
          ) : null}
          {selected.stableSourceId ? (
            <LocationIntroductionPanel state={introduction.state} onRetry={introduction.retry} />
          ) : null}
          {selected.locationReferenceStatus === "loading" ? <p className="mt-3 text-xs text-muted-foreground" role="status">{t("locationReferenceLoading")}</p> : null}
          {selected.locationReferenceStatus === "unavailable" ? <p className="mt-3 text-xs text-muted-foreground" role="status">{t("locationReferenceUnavailable")}</p> : null}
          <button type="button" onClick={startExploring} disabled={exploreState !== "SELECTED"} className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 px-4 font-extrabold wanderly-edge wanderly-r-md wanderly-shadow-sm wanderly-press wanderly-action disabled:cursor-default disabled:opacity-80">
            {exploreState === "SELECTED" ? (
              <><MapPin aria-hidden="true" className="size-4" /> {selected.kind === "geography" ? t("action.viewGeography") : t("action.viewInspiration")}</>
            ) : stateAction(exploreState, selected.kind, t)}
          </button>
          {selected.kind === "inspiration" ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={openPinManager} className="inline-flex min-h-11 items-center justify-center gap-1.5 bg-[var(--w-mist)] text-sm font-extrabold text-primary wanderly-edge-thin wanderly-r-sm wanderly-press">
                <ListChecks aria-hidden="true" className="size-4" /> {t("managePinsCta")}
              </button>
              <button type="button" onClick={() => deleteInspirations([selected.id])} className="inline-flex min-h-11 items-center justify-center gap-1.5 bg-card text-sm font-extrabold text-destructive wanderly-edge-thin wanderly-r-sm wanderly-press">
                <Trash2 aria-hidden="true" className="size-4" /> {t("deleteThisCta")}
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
      <ExploreChatHost
        open={chatOpen}
        onOpen={openChat}
        onDismiss={dismissChat}
        selectedPlace={selected ? { place: toConversationPlace(selected), context: selected.country } : null}
        onConversationText={handleConversationText}
        tripConversationHandoff={tripConversationHandoff}
      />
    </main>
  );
}

export function toConversationPlace(selected: ExploreDestination): ConversationPlace {
  return {
    sourceId: selected.id,
    name: selected.name,
    longitude: selected.coordinates[0],
    latitude: selected.coordinates[1],
    sourceType: selected.locationReference?.outcome === "REFERENCE" ? "REFERENCE" : "INSPIRATION",
  };
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function startGlobeSpin(map: MapLibreMap, animRef: { current: number | null }) {
  stopGlobeSpin(animRef);
  if (reducedMotion()) return;
  const spin = () => {
    if (!map.getContainer().isConnected) return;
    const center = map.getCenter();
    map.setCenter([center.lng + 0.015, center.lat]);
    animRef.current = requestAnimationFrame(spin);
  };
  animRef.current = requestAnimationFrame(spin);
}

function stopGlobeSpin(animRef: { current: number | null }) {
  if (animRef.current !== null) {
    cancelAnimationFrame(animRef.current);
    animRef.current = null;
  }
}

function markerElement(label: string) {
  const anchor = document.createElement("div");
  anchor.className = "wanderly-map-marker-anchor";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wanderly-map-marker wanderly-map-marker--inspiration";
  button.setAttribute("aria-pressed", "false");
  setMarkerLabel(button, label);
  anchor.append(button);

  return { anchor, button };
}

function setMarkerLabel(button: HTMLButtonElement, label: string) {
  let span = button.querySelector("span");
  if (!span) {
    span = document.createElement("span");
    button.append(span);
  }
  span.textContent = label;
}

function inspirationAt(
  id: string,
  sequence: number,
  coordinates: [number, number],
  requestedPinGranularity: PinGranularity = "city",
): Destination {
  return {
    id,
    name: `Pinned place ${sequence}`,
    country: `${coordinates[1].toFixed(3)}°, ${coordinates[0].toFixed(3)}°`,
    coordinates,
    note: "This is an unverified, session-only inspiration. It has no live price, availability, visa or booking data.",
    kind: "inspiration",
    requestedPinGranularity,
    manualPinSequence: sequence,
  };
}

function referenceContext(
  reference: Extract<LocationReferenceResponse, { outcome: "REFERENCE" }>,
  granularity: PinGranularity,
) {
  if (granularity === "country") return reference.country;
  return [reference.admin1, reference.country]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(" · ");
}

function distanceInKm(from: [number, number], to: [number, number]) {
  const earthRadiusKm = 6371;
  const latitudeDelta = degreesToRadians(to[1] - from[1]);
  const longitudeDelta = degreesToRadians(to[0] - from[0]);
  const fromLatitude = degreesToRadians(from[1]);
  const toLatitude = degreesToRadians(to[1]);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(haversine));
}

function isSameCity(destination: Destination, cityName: string, cityCoordinates: [number, number]) {
  if (!destination.cityName) return false;
  return cityKey(null, destination.cityName) === cityKey(null, cityName)
    && distanceInKm(destination.coordinates, cityCoordinates) <= 25;
}

function focusChatOnDestination(
  destination: Destination,
  setSelected: (destination: Destination) => void,
  setExploreState: (state: ExploreState) => void,
  selectedPinIdRef: { current: string | null },
) {
  selectedPinIdRef.current = destination.id;
  setSelected(destination);
  setExploreState("SELECTED");
}

function degreesToRadians(degrees: number) {
  return degrees * (Math.PI / 180);
}

export function configureMapAttribution(root: ParentNode | null) {
  const attribution = root?.querySelector<HTMLDetailsElement>(".maplibregl-ctrl-attrib");
  const toggle = attribution?.querySelector<HTMLElement>(".maplibregl-ctrl-attrib-button");
  if (!attribution || !toggle || attribution.dataset.wanderlyControlled === "true") return;

  let expanded = false;
  attribution.dataset.wanderlyControlled = "true";
  attribution.dataset.wanderlyExpanded = "false";
  attribution.classList.remove("maplibregl-compact-show");
  attribution.removeAttribute("open");
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    expanded = !expanded;
    attribution.dataset.wanderlyExpanded = String(expanded);
    attribution.classList.toggle("maplibregl-compact-show", expanded);
    attribution.toggleAttribute("open", expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
  });
}

function stateLabel(state: ExploreState, t: ReturnType<typeof useTranslations>) {
  if (state === "TALKING") return t("state.TALKING");
  if (state === "FLYING") return t("state.FLYING");
  if (state === "EXPLORING") return t("state.EXPLORING");
  return t("state.IDLE");
}

function stateAction(state: ExploreState, kind: Destination["kind"], t: ReturnType<typeof useTranslations>) {
  if (state === "TALKING") return t("action.TALKING");
  if (state === "FLYING") return t("action.FLYING");
  if (kind === "inspiration") return t("action.inspiration");
  if (kind === "geography") return t("action.geography");
  return t("action.IDLE");
}
