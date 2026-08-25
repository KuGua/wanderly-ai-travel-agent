"use client";

import { CheckSquare, Compass, HelpCircle, ListChecks, LoaderCircle, LocateFixed, MapPin, Plane, RotateCw, Sparkles, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker, StyleSpecification } from "maplibre-gl";
import { applyGeographyContrast, GEOGRAPHY_INTERACTIVE_LAYER_IDS, geographyFeatureFrom, inspectGeographyLayers, OPEN_MAP_TILES_SOURCE, setGeographyLayerVisibility, type GeographyInspection, type GeographyVisibility } from "./map-geography-layers";
import { INITIAL_READINESS, layerCaptionFor, mapReadinessStage, panelDisabledReason, type LayerCaption, type MapReadiness, type MapStage } from "./map-readiness";

type Destination = {
  id: string;
  name: string;
  country: string;
  coordinates: [number, number];
  note: string;
  kind: "fixture" | "inspiration" | "geography";
};

type ExploreState = "IDLE" | "SELECTED" | "TALKING" | "FLYING" | "EXPLORING";
type PinScope = "nearby" | "all";
type SourceEventDiagnostic = {
  sourceDataType: string | null;
  isSourceLoaded: boolean | null;
};

const SINGAPORE: [number, number] = [103.8198, 1.3521];
const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";
const NEARBY_RADIUS_KM = 50;

const DESTINATION_IDS = ["tokyo", "lisbon", "reykjavik"] as const;

const FIXTURE_COORDS: Record<(typeof DESTINATION_IDS)[number], [number, number]> = {
  tokyo: [139.6917, 35.6895],
  lisbon: [-9.1393, 38.7223],
  reykjavik: [-21.9426, 64.1466],
};

export function ExploreMapPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const inspirationMarkersRef = useRef(new Map<string, MapLibreMarker>());
  const inspirationsRef = useRef<Destination[]>([]);
  const inspirationSequenceRef = useRef(0);
  const journeyTimersRef = useRef<number[]>([]);
  const geographyVisibilityRef = useRef<GeographyVisibility>({ countries: true, regions: true, cities: true });
  const [readiness, setReadiness] = useState<MapReadiness>(INITIAL_READINESS);
  const readinessRef = useRef<MapReadiness>(INITIAL_READINESS);
  const styleLoadedRef = useRef(false);

  const t = useTranslations("explore");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const destinations = useMemo<Destination[]>(
    () =>
      DESTINATION_IDS.map((id) => ({
        id,
        name: t(`destinations.${id}`),
        country: t(`destinations.${id}Country`),
        coordinates: FIXTURE_COORDS[id],
        note: t(`destinations.${id}Note`),
        kind: "fixture" as const,
      })),
    [t],
  );

  useEffect(() => {
    readinessRef.current = readiness;
  }, [readiness]);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [geographyVisibility, setGeographyVisibility] = useState<GeographyVisibility>({ countries: true, regions: true, cities: true });
  const [selected, setSelected] = useState<Destination | null>(null);
  const [inspirations, setInspirations] = useState<Destination[]>([]);
  const [checkedInspirationIds, setCheckedInspirationIds] = useState<Set<string>>(new Set());
  const [managePinsOpen, setManagePinsOpen] = useState(false);
  const [manageAnchorCoordinates, setManageAnchorCoordinates] = useState<[number, number] | null>(null);
  const [pinScope, setPinScope] = useState<PinScope>("nearby");
  const [exploreState, setExploreState] = useState<ExploreState>("IDLE");
  const [helpOpen, setHelpOpen] = useState(false);

  const clearJourneyTimers = useCallback(() => {
    journeyTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    journeyTimersRef.current = [];
  }, []);

  const selectDestination = useCallback(
    (destination: Destination) => {
      clearJourneyTimers();
      setSelected(destination);
      setExploreState("SELECTED");
      if (destination.kind === "fixture") {
        mapRef.current?.flyTo({ center: destination.coordinates, zoom: 4.8, duration: reducedMotion() ? 0 : 1600 });
      }
    },
    [clearJourneyTimers],
  );

  const deleteInspirations = useCallback(
    (ids: Iterable<string>) => {
      const idsToDelete = new Set(ids);
      if (idsToDelete.size === 0) return;

      idsToDelete.forEach((id) => {
        inspirationMarkersRef.current.get(id)?.remove();
        inspirationMarkersRef.current.delete(id);
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

  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    const inspirationMarkers = inspirationMarkersRef.current;
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
      if (inspection.supported) applyGeographyContrast(map);
      setGeographyLayerVisibility(map, geographyVisibilityRef.current);
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
        const maplibregl = await import("maplibre-gl");
        if (cancelled || !containerRef.current) return;

        const map = new maplibregl.Map({
          container: containerRef.current,
          style: MAP_STYLE_URL as unknown as StyleSpecification | string,
          center: SINGAPORE,
          zoom: 2.25,
          attributionControl: false,
        });
        mapRef.current = map;
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
        map.on("sourcedata", onSourceData);

        map.once("style.load", () => {
          try {
            loaded = true;
            styleLoadedRef.current = true;
            window.clearTimeout(loadTimeout);
            map.addControl(new maplibregl.AttributionControl({ compact: window.innerWidth < 640 }), "bottom-right");
            map.setProjection({ type: "globe" });
            finalizeReadiness(map, inspectGeographyLayers(map, MAP_STYLE_URL));
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
          const geography = event.point
            ? geographyFeatureFrom(map.queryRenderedFeatures(event.point, { layers: [...GEOGRAPHY_INTERACTIVE_LAYER_IDS] })[0])
            : null;
          if (geography) {
            const countryLabel =
              geography.kind === "country"
                ? t("geographyCountryLabel")
                : geography.kind === "city"
                  ? t("geographyCityLabel")
                  : t("geographyStateLabel");
            selectDestination({
              id: `geography-${geography.kind}-${event.lngLat.lng.toFixed(5)}-${event.lngLat.lat.toFixed(5)}`,
              name: geography.name,
              country: countryLabel,
              coordinates: [event.lngLat.lng, event.lngLat.lat],
              note: t("geographyNote"),
              kind: "geography",
            });
            return;
          }
          inspirationSequenceRef.current += 1;
          const inspiration = inspirationAt(
            `inspiration-${inspirationSequenceRef.current}`,
            inspirationSequenceRef.current,
            [event.lngLat.lng, event.lngLat.lat],
          );
          const { anchor, button } = markerElement(inspiration.name, true);
          button.setAttribute("aria-label", t("markerOpenAria", { name: inspiration.name }));
          button.addEventListener("click", (markerEvent) => {
            markerEvent.stopPropagation();
            selectDestination(inspiration);
          });
          const marker = new maplibregl.Marker({ element: anchor, anchor: "bottom" })
            .setLngLat(inspiration.coordinates)
            .addTo(map);
          inspirationMarkers.set(inspiration.id, marker);
          inspirationsRef.current = [...inspirationsRef.current, inspiration];
          setInspirations(inspirationsRef.current);
          selectDestination(inspiration);
        });

        const syncInspirationPositions = () => {
          inspirationsRef.current.forEach((inspiration) => {
            inspirationMarkers.get(inspiration.id)?.setLngLat(inspiration.coordinates);
          });
        };
        map.on("move", syncInspirationPositions);

        markersRef.current = destinations.map((destination) => {
          const { anchor, button } = markerElement(destination.name);
          button.setAttribute("aria-label", t("markerExploreAria", { name: destination.name, country: destination.country }));
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            selectDestination(destination);
          });
          return new maplibregl.Marker({ element: anchor, anchor: "bottom" })
            .setLngLat(destination.coordinates)
            .addTo(map);
        });
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
      mapRef.current?.off("sourcedata", onSourceData);
      clearJourneyTimers();
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      inspirationMarkers.forEach((marker) => marker.remove());
      inspirationMarkers.clear();
      inspirationsRef.current = [];
      inspirationSequenceRef.current = 0;
      styleLoadedRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [clearJourneyTimers, mapAttempt, selectDestination, destinations, t]);

  useEffect(() => {
    if (mapRef.current && readiness.kind === "ready-supported") {
      setGeographyLayerVisibility(mapRef.current, geographyVisibility);
    }
  }, [readiness, geographyVisibility]);

  function recenter() {
    clearJourneyTimers();
    mapRef.current?.flyTo({ center: SINGAPORE, zoom: 2.25, duration: reducedMotion() ? 0 : 1400 });
    setSelected(null);
    setExploreState("IDLE");
  }

  function startExploring() {
    if (!selected) return;
    clearJourneyTimers();
    if (reducedMotion()) {
      setExploreState("EXPLORING");
      return;
    }
    setExploreState("TALKING");
    journeyTimersRef.current = [
      window.setTimeout(() => setExploreState("FLYING"), 650),
      window.setTimeout(() => setExploreState("EXPLORING"), 1900),
    ];
  }

  function retryMap() {
    readinessRef.current = INITIAL_READINESS;
    setReadiness(INITIAL_READINESS);
    setMapAttempt((attempt) => attempt + 1);
  }

  function toggleGeographyLayer(layer: keyof GeographyVisibility) {
    setGeographyVisibility((current) => {
      const next = { ...current, [layer]: !current[layer] };
      geographyVisibilityRef.current = next;
      return next;
    });
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

  const managedInspirations = pinScope === "all" || !manageAnchorCoordinates
    ? inspirations
    : inspirations.filter((inspiration) => distanceInKm(inspiration.coordinates, manageAnchorCoordinates) <= NEARBY_RADIUS_KM);

  const nearbyDistance = useMemo(() => {
    const formatter = new Intl.NumberFormat(locale || "en", { style: "unit", unit: "kilometer", unitDisplay: "short" });
    return formatter.format(NEARBY_RADIUS_KM);
  }, [locale]);

  return (
    <main data-drawer-open={selected ? "true" : "false"} className="relative isolate h-[calc(100dvh-4rem)] min-h-[620px] overflow-hidden bg-[#bfe9f2] md:h-screen">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_58%_42%,#dff5ee_0_15%,#8bd2df_35%,#65b7ca_62%,#4b9eb5_100%)]" aria-hidden="true" />
      <div className="absolute inset-0">
        <div ref={containerRef} className="size-full" aria-label={t("globeAriaLabel")} />
      </div>

      {readiness.kind === "loading" ? (
        <div className="pointer-events-none absolute inset-0 z-[4] grid place-items-center" role="status">
          <span className="inline-flex items-center gap-2 rounded-full bg-card/90 px-4 py-2 text-sm font-bold text-primary shadow-lg backdrop-blur">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> {tCommon("loadingGlobe")}
          </span>
        </div>
      ) : null}

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-4 p-4 sm:p-6">
        <div className="pointer-events-auto rounded-[20px] bg-sidebar/95 px-4 py-3 text-white shadow-[0_12px_32px_#0a2f3f33] backdrop-blur">
          <p className="font-black tracking-[-0.035em]">{tCommon("brandTagline")}</p>
          <p className="mt-0.5 text-xs text-[#bde1db]">{t("startingFrom")}</p>
        </div>
        <div className="pointer-events-auto flex gap-2">
          <button type="button" onClick={recenter} aria-label={t("recenterAriaLabel")} title={t("recenterTitle")} className="grid size-12 place-items-center rounded-[16px] bg-sidebar/95 text-white shadow-lg backdrop-blur focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/50">
            <LocateFixed aria-hidden="true" className="size-5" />
          </button>
          <button type="button" onClick={() => setHelpOpen((open) => !open)} aria-label={t("helpAriaLabel")} aria-expanded={helpOpen} title={t("helpTitle")} className="grid size-12 place-items-center rounded-[16px] bg-sidebar/95 text-white shadow-lg backdrop-blur focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/50">
            <HelpCircle aria-hidden="true" className="size-5" />
          </button>
        </div>
      </header>

      {helpOpen ? (
        <aside className="absolute right-4 top-20 z-30 w-[min(320px,calc(100%-2rem))] rounded-[20px] bg-card/95 p-4 text-sm leading-6 shadow-xl backdrop-blur sm:right-6 sm:top-24">
          <p className="font-bold">{t("helpHeading")}</p>
          <p className="mt-1 text-muted-foreground">{t("helpBody")}</p>
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

      <section className={`absolute bottom-4 left-4 z-20 rounded-[24px] bg-card/95 shadow-[0_20px_60px_#082f3f40] backdrop-blur sm:bottom-6 sm:left-6 ${managePinsOpen ? "w-[min(360px,calc(100%-2rem))] p-4" : "w-[min(420px,calc(100%-2rem))] p-5"} ${selected && !managePinsOpen ? "hidden sm:block" : ""}`}>
        {!managePinsOpen ? (
          <>
            <div className="flex items-center gap-2 text-primary">
              <Sparkles aria-hidden="true" className="size-4" />
              <p className="text-[11px] font-black uppercase tracking-[0.14em]">{t("panelKicker")}</p>
            </div>
            <h1 className="mt-2 text-2xl font-bold tracking-[-0.045em]">{t("panelTitle")}</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("panelBody")}</p>
            {inspirations.length > 0 ? <p className="mt-2 text-xs font-bold text-primary">{t("pinCount", { count: inspirations.length })}</p> : null}
            <div className="mt-4 flex flex-wrap gap-2" aria-label={t("suggestionsAriaLabel")}>
              {destinations.map((destination) => (
                <button key={destination.id} type="button" onClick={() => selectDestination(destination)} className="inline-flex min-h-10 items-center gap-1.5 rounded-full border bg-background px-3 text-sm font-bold transition hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
                  <MapPin aria-hidden="true" className="size-3.5" /> {destination.name}
                </button>
              ))}
            </div>
          </>
        ) : (
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
                {t("manageScopeNearby")}
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
        )}
      </section>

      {readiness.kind !== "loading" && readiness.kind !== "unavailable-network" ? (
        <LayerToggleGroup
          visibility={geographyVisibility}
          disabledReason={panelDisabledReason(readiness)}
          caption={layerCaptionFor(panelDisabledReason(readiness), readiness.kind === "ready-style-missing-layers" ? readiness.missingLayers : [])}
          onToggle={toggleGeographyLayer}
          t={t}
        />
      ) : null}

      {selected && !managePinsOpen ? (
        <aside className="absolute inset-x-0 bottom-0 z-30 max-h-[70dvh] overflow-y-auto rounded-t-[24px] bg-card/95 p-5 shadow-[0_20px_60px_#082f3f55] backdrop-blur sm:inset-x-auto sm:bottom-auto sm:right-6 sm:top-28 sm:w-[min(360px,calc(100%-2rem))] sm:rounded-[24px]">
          <button type="button" onClick={() => { clearJourneyTimers(); setSelected(null); setExploreState("IDLE"); }} aria-label={t("drawerCloseAriaLabel")} className="absolute right-4 top-4 grid size-9 place-items-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
            <X aria-hidden="true" className="size-4" />
          </button>
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-primary">{stateLabel(exploreState, t)}</p>
          <h2 className="mt-2 pr-9 text-3xl font-bold tracking-[-0.05em]">{selected.name}</h2>
          <p className="font-semibold text-muted-foreground">{selected.country}</p>
          <p className="mt-3 inline-flex rounded-full bg-secondary px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-secondary-foreground">
            {selected.kind === "fixture" ? t("drawerKindFixture") : selected.kind === "geography" ? t("drawerKindGeography") : t("drawerKindInspiration")}
          </p>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">{selected.note}</p>
          <button type="button" onClick={startExploring} disabled={exploreState !== "SELECTED"} className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[16px] bg-primary px-4 font-bold text-primary-foreground transition hover:brightness-110 disabled:cursor-default disabled:opacity-80 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
            {exploreState === "SELECTED" ? (
              selected.kind === "fixture"
                ? <><Plane aria-hidden="true" className="size-4" /> {t("action.fixture", { name: selected.name })}</>
                : <><MapPin aria-hidden="true" className="size-4" /> {selected.kind === "geography" ? t("action.viewGeography") : t("action.viewInspiration")}</>
            ) : stateAction(exploreState, selected.kind, t)}
          </button>
          {selected.kind === "inspiration" ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={openPinManager} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[14px] text-sm font-bold text-primary hover:bg-secondary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
                <ListChecks aria-hidden="true" className="size-4" /> {t("managePinsCta")}
              </button>
              <button type="button" onClick={() => deleteInspirations([selected.id])} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[14px] text-sm font-bold text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-destructive/20">
                <Trash2 aria-hidden="true" className="size-4" /> {t("deleteThisCta")}
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
    </main>
  );
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function markerElement(label: string, inspiration = false) {
  const anchor = document.createElement("div");
  anchor.className = "wanderly-map-marker-anchor";

  const button = document.createElement("button");
  button.type = "button";
  button.className = inspiration
    ? "wanderly-map-marker wanderly-map-marker--inspiration"
    : "wanderly-map-marker";
  button.innerHTML = `<span>${label}</span>`;
  anchor.append(button);

  return { anchor, button };
}

function inspirationAt(id: string, sequence: number, coordinates: [number, number]): Destination {
  return {
    id,
    name: `Pinned place ${sequence}`,
    country: `${coordinates[1].toFixed(3)}°, ${coordinates[0].toFixed(3)}°`,
    coordinates,
    note: "This is an unverified, session-only inspiration. It has no live price, availability, visa or booking data.",
    kind: "inspiration",
  };
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

function degreesToRadians(degrees: number) {
  return degrees * (Math.PI / 180);
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

function LayerToggleGroup({
  visibility,
  disabledReason,
  caption,
  onToggle,
  t,
}: {
  visibility: GeographyVisibility;
  disabledReason: null | "missing-source" | "missing-layers";
  caption: LayerCaption;
  onToggle: (layer: keyof GeographyVisibility) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const disabled = disabledReason !== null;
  const labels: Record<keyof GeographyVisibility, string> = {
    countries: t("layerPanel.countries"),
    regions: t("layerPanel.regions"),
    cities: t("layerPanel.cities"),
  };
  const captionText = (() => {
    if (!caption) return t("layerPanel.captionSupported");
    if (caption.kind === "missing-source") return t("layerPanel.captionMissingSource");
    return t("layerPanel.captionMissingLayers", { layers: caption.layers.join(", ") });
  })();
  return (
    <section
      className="absolute left-4 top-32 z-20 w-44 rounded-[18px] bg-card/95 p-2 shadow-lg backdrop-blur sm:left-6 sm:top-36"
      role="group"
      aria-label={t("layerPanel.groupAriaLabel")}
      data-readiness={disabledReason ?? "supported"}
    >
      <p className="px-2 pb-1 text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">{t("layerPanel.kicker")}</p>
      {(["countries", "regions", "cities"] as const).map((layer) => (
        <button
          key={layer}
          type="button"
          aria-pressed={visibility[layer]}
          disabled={disabled}
          onClick={() => onToggle(layer)}
          className="flex min-h-11 w-full items-center rounded-[12px] px-2 text-left text-xs font-bold aria-pressed:bg-secondary aria-pressed:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {labels[layer]}
        </button>
      ))}
      <p
        className="px-2 pb-1 pt-1 text-[10px] leading-4 text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {captionText}
      </p>
    </section>
  );
}