"use client";

import { CheckSquare, Compass, HelpCircle, ListChecks, LoaderCircle, LocateFixed, MapPin, Plane, RotateCw, Sparkles, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";

import { TravelAgentChat } from "./travel-agent-chat";

type Destination = {
  id: string;
  name: string;
  country: string;
  coordinates: [number, number];
  note: string;
  kind: "fixture" | "inspiration";
};

type ExploreState = "IDLE" | "SELECTED" | "TALKING" | "FLYING" | "EXPLORING";
type PinScope = "nearby" | "all";

const SINGAPORE: [number, number] = [103.8198, 1.3521];
const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";

const destinations: Destination[] = [
  { id: "tokyo", name: "Tokyo", country: "Japan", coordinates: [139.6917, 35.6895], note: "Food, design and neighborhoods that reward wandering.", kind: "fixture" },
  { id: "lisbon", name: "Lisbon", country: "Portugal", coordinates: [-9.1393, 38.7223], note: "Hillside streets, Atlantic light and late dinners.", kind: "fixture" },
  { id: "reykjavik", name: "Reykjavík", country: "Iceland", coordinates: [-21.9426, 64.1466], note: "A compact base for geothermal landscapes.", kind: "fixture" },
];

export function ExploreMapPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const inspirationMarkersRef = useRef(new Map<string, MapLibreMarker>());
  const inspirationsRef = useRef<Destination[]>([]);
  const inspirationSequenceRef = useRef(0);
  const chatCameraActiveRef = useRef(false);
  const journeyTimersRef = useRef<number[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [selected, setSelected] = useState<Destination | null>(null);
  const [inspirations, setInspirations] = useState<Destination[]>([]);
  const [checkedInspirationIds, setCheckedInspirationIds] = useState<Set<string>>(new Set());
  const [managePinsOpen, setManagePinsOpen] = useState(false);
  const [manageAnchorCoordinates, setManageAnchorCoordinates] = useState<[number, number] | null>(null);
  const [pinScope, setPinScope] = useState<PinScope>("nearby");
  const [chatOpen, setChatOpen] = useState(false);
  const [exploreState, setExploreState] = useState<ExploreState>("IDLE");
  const [helpOpen, setHelpOpen] = useState(false);

  const clearJourneyTimers = useCallback(() => {
    journeyTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    journeyTimersRef.current = [];
  }, []);

  const selectDestination = useCallback((destination: Destination) => {
    clearJourneyTimers();
    setSelected(destination);
    setExploreState("SELECTED");
    if (destination.kind === "fixture") {
      mapRef.current?.flyTo({ center: destination.coordinates, zoom: 4.8, duration: reducedMotion() ? 0 : 1600 });
    }
  }, [clearJourneyTimers]);

  const deleteInspirations = useCallback((ids: Iterable<string>) => {
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
  }, [clearJourneyTimers]);

  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    const inspirationMarkers = inspirationMarkersRef.current;
    const loadTimeout = window.setTimeout(() => {
      if (!cancelled && !loaded) {
        setMapUnavailable(true);
      }
    }, 12_000);

    async function initializeMap() {
      if (!containerRef.current || mapRef.current) return;

      try {
        const maplibregl = await import("maplibre-gl");
        if (cancelled || !containerRef.current) return;

        const map = new maplibregl.Map({
          container: containerRef.current,
          style: MAP_STYLE_URL,
          center: SINGAPORE,
          zoom: 2.25,
          attributionControl: false,
        });
        mapRef.current = map;
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

        map.once("style.load", () => {
          loaded = true;
          window.clearTimeout(loadTimeout);
          map.setProjection({ type: "globe" });
          map.addControl(new maplibregl.AttributionControl({ compact: window.innerWidth < 640 }), "bottom-right");
          window.queueMicrotask(() => {
            if (!cancelled) configureMapAttribution(containerRef.current);
          });
          if (!cancelled) {
            setMapReady(true);
            setMapUnavailable(false);
          }
        });

        map.on("error", () => {
          if (!loaded && !cancelled) setMapUnavailable(true);
        });

        map.on("click", (event) => {
          inspirationSequenceRef.current += 1;
          const inspiration = inspirationAt(
            `inspiration-${inspirationSequenceRef.current}`,
            inspirationSequenceRef.current,
            [event.lngLat.lng, event.lngLat.lat],
          );
          const { anchor, button } = markerElement(inspiration.name, true);
          button.setAttribute("aria-label", `Open ${inspiration.name}`);
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
          button.setAttribute("aria-label", `Explore ${destination.name}, ${destination.country}`);
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
          setMapUnavailable(true);
        }
      }
    }

    void initializeMap();

    return () => {
      cancelled = true;
      window.clearTimeout(loadTimeout);
      clearJourneyTimers();
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      inspirationMarkers.forEach((marker) => marker.remove());
      inspirationMarkers.clear();
      inspirationsRef.current = [];
      inspirationSequenceRef.current = 0;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [clearJourneyTimers, mapAttempt, selectDestination]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !window.matchMedia("(max-width: 639px)").matches) return;

    if (!chatOpen) {
      if (chatCameraActiveRef.current) {
        map.easeTo({ padding: { top: 0, right: 0, bottom: 0, left: 0 }, duration: reducedMotion() ? 0 : 450 });
        chatCameraActiveRef.current = false;
      }
      return;
    }

    const bottomPadding = Math.round(window.innerHeight * 0.43) + 24;
    const currentCenter = map.getCenter();
    map.easeTo({
      center: selected ? selected.coordinates : [currentCenter.lng, currentCenter.lat],
      zoom: selected ? Math.max(map.getZoom(), 5.4) : map.getZoom() + Math.log2(0.8),
      padding: { top: 0, right: 0, bottom: bottomPadding, left: 0 },
      duration: reducedMotion() ? 0 : 650,
    });
    chatCameraActiveRef.current = true;
  }, [chatOpen, mapReady, selected]);

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
    setMapUnavailable(false);
    setMapReady(false);
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

  const managedInspirations = pinScope === "all" || !manageAnchorCoordinates
    ? inspirations
    : inspirations.filter((inspiration) => distanceInKm(inspiration.coordinates, manageAnchorCoordinates) <= 50);

  return (
    <main data-drawer-open={selected && !chatOpen ? "true" : "false"} className="wanderly-explore-map relative isolate h-[calc(100dvh-4rem)] min-h-[620px] overflow-hidden bg-[#bfe9f2] md:h-screen">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_58%_42%,#dff5ee_0_15%,#8bd2df_35%,#65b7ca_62%,#4b9eb5_100%)]" aria-hidden="true" />
      <div className="absolute inset-0">
        <div ref={containerRef} className="size-full" aria-label="Interactive destination globe" />
      </div>

      {!mapReady && !mapUnavailable ? (
        <div className="pointer-events-none absolute inset-0 z-[4] grid place-items-center" role="status">
          <span className="inline-flex items-center gap-2 rounded-full bg-card/90 px-4 py-2 text-sm font-bold text-primary shadow-lg backdrop-blur">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> Loading the globe…
          </span>
        </div>
      ) : null}

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-4 p-4 sm:p-6">
        <div className="pointer-events-auto rounded-[20px] bg-sidebar/95 px-4 py-3 text-white shadow-[0_12px_32px_#0a2f3f33] backdrop-blur">
          <p className="font-black tracking-[-0.035em]">Wanderly AI</p>
          <p className="mt-0.5 text-xs text-[#bde1db]">Starting from Singapore</p>
        </div>
        <div className="pointer-events-auto flex gap-2">
          <button type="button" onClick={recenter} aria-label="Recenter on Singapore" title="Recenter" className="grid size-12 place-items-center rounded-[16px] bg-sidebar/95 text-white shadow-lg backdrop-blur focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/50">
            <LocateFixed aria-hidden="true" className="size-5" />
          </button>
          <button type="button" onClick={() => setHelpOpen((open) => !open)} aria-label="Explore map help" aria-expanded={helpOpen} title="How to use Explore" className="grid size-12 place-items-center rounded-[16px] bg-sidebar/95 text-white shadow-lg backdrop-blur focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/50">
            <HelpCircle aria-hidden="true" className="size-5" />
          </button>
        </div>
      </header>

      <button type="button" onClick={() => mapRef.current?.resetNorth({ duration: reducedMotion() ? 0 : 450 })} aria-label="Reset map compass" title="Reset map compass" className={`absolute left-4 z-40 grid size-12 place-items-center rounded-full bg-sidebar/95 text-white shadow-lg backdrop-blur transition-[bottom] duration-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/50 md:hidden ${chatOpen ? "bottom-[calc(43dvh+1rem)]" : "bottom-20"}`}>
        <Compass aria-hidden="true" className="size-5" />
      </button>

      {helpOpen ? (
        <aside className="absolute right-4 top-20 z-30 w-[min(320px,calc(100%-2rem))] rounded-[20px] bg-card/95 p-4 text-sm leading-6 shadow-xl backdrop-blur sm:right-6 sm:top-24">
          <p className="font-bold">Explore the map</p>
          <p className="mt-1 text-muted-foreground">Choose a named demo destination, or click anywhere to pin multiple private inspirations. Select pins from the list to remove them individually or together.</p>
        </aside>
      ) : null}

      {mapUnavailable ? (
        <section className="absolute inset-0 z-[5] grid place-items-center bg-[radial-gradient(circle_at_center,#d7edb0_0_19%,transparent_20%),radial-gradient(circle_at_25%_38%,#e8cc89_0_11%,transparent_12%),#82cad8] p-6 text-center">
          <div className="max-w-md rounded-[24px] bg-card/95 p-7 shadow-2xl backdrop-blur">
            <Compass aria-hidden="true" className="mx-auto size-9 text-primary" />
            <h1 className="mt-4 text-2xl font-bold tracking-[-0.04em]">The globe could not load</h1>
            <p className="mt-2 text-sm text-muted-foreground">You can still choose a destination below. Map access may be unavailable on this network.</p>
            <button type="button" onClick={retryMap} className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-[14px] bg-primary px-4 font-bold text-primary-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
              <RotateCw aria-hidden="true" className="size-4" /> Retry map
            </button>
          </div>
        </section>
      ) : null}

      <section className={`absolute bottom-20 left-4 z-20 rounded-[24px] bg-card/95 shadow-[0_20px_60px_#082f3f40] backdrop-blur sm:bottom-6 sm:left-6 ${managePinsOpen ? "block w-[min(360px,calc(100%-2rem))] p-4" : "hidden w-[min(420px,calc(100%-2rem))] p-5 sm:block"} ${selected && !managePinsOpen ? "sm:block" : ""}`}>
        {!managePinsOpen ? (
          <>
            <div className="flex items-center gap-2 text-primary">
              <Sparkles aria-hidden="true" className="size-4" />
              <p className="text-[11px] font-black uppercase tracking-[0.14em]">Where should we go next?</p>
            </div>
            <h1 className="mt-2 text-2xl font-bold tracking-[-0.045em]">Explore the world</h1>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">Click anywhere on the map to collect private inspirations for this session.</p>
            {inspirations.length > 0 ? <p className="mt-2 text-xs font-bold text-primary">{inspirations.length} private {inspirations.length === 1 ? "pin" : "pins"} on this map</p> : null}
            <div className="mt-4 flex flex-wrap gap-2" aria-label="Destination suggestions">
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
                  <p className="text-[11px] font-black uppercase tracking-[0.14em]">Private inspirations</p>
                </div>
                <h1 className="mt-1 text-xl font-bold tracking-[-0.045em]">Manage pins</h1>
              </div>
              <button type="button" onClick={() => { setManagePinsOpen(false); setCheckedInspirationIds(new Set()); }} aria-label="Close pin manager" className="grid size-9 place-items-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Choose only the places you want to remove.</p>
            <div className="mt-3 grid grid-cols-2 rounded-[12px] bg-muted p-1" aria-label="Pin display scope">
              <button type="button" aria-pressed={pinScope === "nearby"} onClick={() => setPinScope("nearby")} className="min-h-9 rounded-[9px] px-2 text-xs font-bold aria-pressed:bg-card aria-pressed:text-primary aria-pressed:shadow-sm">Current area</button>
              <button type="button" aria-pressed={pinScope === "all"} onClick={() => setPinScope("all")} className="min-h-9 rounded-[9px] px-2 text-xs font-bold aria-pressed:bg-card aria-pressed:text-primary aria-pressed:shadow-sm">All pins ({inspirations.length})</button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">Current area shows pins within 50 km of this place.</p>
            <div className="mt-2 max-h-40 space-y-1.5 overflow-y-auto pr-1" role="list" aria-label="Private inspiration list">
              {managedInspirations.map((inspiration) => (
                <div key={inspiration.id} role="listitem" className={`flex items-center gap-1.5 rounded-[11px] border p-1.5 transition ${selected?.id === inspiration.id ? "border-primary bg-secondary/60" : "bg-background/75"}`}>
                  <input type="checkbox" checked={checkedInspirationIds.has(inspiration.id)} onChange={() => toggleInspiration(inspiration.id)} aria-label={`Select ${inspiration.name}`} className="size-4 shrink-0 accent-[var(--primary)]" />
                  <button type="button" onClick={() => selectDestination(inspiration)} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
                    <span className="block truncate text-xs font-bold">{inspiration.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{inspiration.country}</span>
                  </button>
                </div>
              ))}
            </div>
            <button type="button" disabled={checkedInspirationIds.size === 0} onClick={() => deleteInspirations(checkedInspirationIds)} className="mt-2.5 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-[12px] bg-destructive px-3 text-xs font-bold text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-destructive/25">
              <CheckSquare aria-hidden="true" className="size-4" /> Delete selected{checkedInspirationIds.size > 0 ? ` (${checkedInspirationIds.size})` : ""}
            </button>
          </>
        )}
      </section>

      {selected && !managePinsOpen && !chatOpen ? (
        <aside className="absolute inset-x-0 bottom-0 z-30 max-h-[70dvh] overflow-y-auto rounded-t-[24px] bg-card/95 p-5 pb-24 shadow-[0_20px_60px_#082f3f55] backdrop-blur sm:inset-x-auto sm:bottom-auto sm:right-6 sm:top-28 sm:w-[min(360px,calc(100%-2rem))] sm:rounded-[24px] sm:pb-5">
          <button type="button" onClick={() => { clearJourneyTimers(); setSelected(null); setExploreState("IDLE"); }} aria-label="Close destination preview" className="absolute right-4 top-4 grid size-9 place-items-center rounded-full hover:bg-muted focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
            <X aria-hidden="true" className="size-4" />
          </button>
          <p className="text-[11px] font-black uppercase tracking-[0.14em] text-primary">{stateLabel(exploreState)}</p>
          <h2 className="mt-2 pr-9 text-3xl font-bold tracking-[-0.05em]">{selected.name}</h2>
          <p className="font-semibold text-muted-foreground">{selected.country}</p>
          <p className="mt-3 inline-flex rounded-full bg-secondary px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-secondary-foreground">
            {selected.kind === "fixture" ? "Demo data" : "Session-only inspiration"}
          </p>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">{selected.note}</p>
          <button type="button" onClick={startExploring} disabled={exploreState !== "SELECTED"} className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[16px] bg-primary px-4 font-bold text-primary-foreground transition hover:brightness-110 disabled:cursor-default disabled:opacity-80 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
            {exploreState === "SELECTED" ? (
              selected.kind === "fixture"
                ? <><Plane aria-hidden="true" className="size-4" /> Explore {selected.name}</>
                : <><MapPin aria-hidden="true" className="size-4" /> View this inspiration</>
            ) : stateAction(exploreState, selected.kind)}
          </button>
          {selected.kind === "inspiration" ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={openPinManager} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[14px] text-sm font-bold text-primary hover:bg-secondary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30">
                <ListChecks aria-hidden="true" className="size-4" /> Manage pins
              </button>
              <button type="button" onClick={() => deleteInspirations([selected.id])} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[14px] text-sm font-bold text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-destructive/20">
                <Trash2 aria-hidden="true" className="size-4" /> Delete this
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
      <TravelAgentChat
        onOpenChange={setChatOpen}
        selectedPlace={selected ? { name: selected.name, context: selected.country } : null}
      />
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

function stateLabel(state: ExploreState) {
  if (state === "TALKING") return "Preparing your route";
  if (state === "FLYING") return "Flying there";
  if (state === "EXPLORING") return "Ready to explore";
  return "Destination preview";
}

function stateAction(state: ExploreState, kind: Destination["kind"]) {
  if (state === "TALKING") return "Getting to know the destination…";
  if (state === "FLYING") return "Flying across the globe…";
  if (kind === "inspiration") return "Kept for this session";
  return "Start a travel plan";
}
