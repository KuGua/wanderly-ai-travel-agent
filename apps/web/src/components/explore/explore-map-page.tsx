"use client";

import { Compass, HelpCircle, LoaderCircle, LocateFixed, MapPin, Plane, RotateCw, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap, Marker as MapLibreMarker } from "maplibre-gl";

type Destination = {
  name: string;
  country: string;
  coordinates: [number, number];
  note: string;
  kind: "fixture" | "inspiration";
};

type ExploreState = "IDLE" | "SELECTED" | "TALKING" | "FLYING" | "EXPLORING";

const SINGAPORE: [number, number] = [103.8198, 1.3521];
const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";

const destinations: Destination[] = [
  { name: "Tokyo", country: "Japan", coordinates: [139.6917, 35.6895], note: "Food, design and neighborhoods that reward wandering.", kind: "fixture" },
  { name: "Lisbon", country: "Portugal", coordinates: [-9.1393, 38.7223], note: "Hillside streets, Atlantic light and late dinners.", kind: "fixture" },
  { name: "Reykjavík", country: "Iceland", coordinates: [-21.9426, 64.1466], note: "A compact base for geothermal landscapes.", kind: "fixture" },
];

export function ExploreMapPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const inspirationMarkerRef = useRef<MapLibreMarker | null>(null);
  const journeyTimersRef = useRef<number[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [selected, setSelected] = useState<Destination | null>(null);
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
    mapRef.current?.flyTo({ center: destination.coordinates, zoom: 4.8, duration: reducedMotion() ? 0 : 1600 });
  }, [clearJourneyTimers]);

  useEffect(() => {
    let cancelled = false;
    let loaded = false;
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
          if (!cancelled) {
            setMapReady(true);
            setMapUnavailable(false);
          }
        });

        map.on("error", () => {
          if (!loaded && !cancelled) setMapUnavailable(true);
        });

        map.on("click", (event) => {
          const inspiration: Destination = {
            name: "Pinned place",
            country: `${event.lngLat.lat.toFixed(3)}°, ${event.lngLat.lng.toFixed(3)}°`,
            coordinates: [event.lngLat.lng, event.lngLat.lat],
            note: "This is an unverified, session-only inspiration. It has no live price, availability, visa or booking data.",
            kind: "inspiration",
          };

          inspirationMarkerRef.current?.remove();
          const marker = document.createElement("button");
          marker.type = "button";
          marker.className = "wanderly-map-marker wanderly-map-marker--inspiration";
          marker.setAttribute("aria-label", `Session-only inspiration at ${inspiration.country}`);
          marker.innerHTML = "<span>Private inspiration</span>";
          marker.addEventListener("click", (markerEvent) => {
            markerEvent.stopPropagation();
            selectDestination(inspiration);
          });
          inspirationMarkerRef.current = new maplibregl.Marker({ element: marker, anchor: "bottom" })
            .setLngLat(inspiration.coordinates)
            .addTo(map);
          selectDestination(inspiration);
        });

        markersRef.current = destinations.map((destination) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "wanderly-map-marker";
          button.setAttribute("aria-label", `Explore ${destination.name}, ${destination.country}`);
          button.innerHTML = `<span>${destination.name}</span>`;
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            selectDestination(destination);
          });
          return new maplibregl.Marker({ element: button, anchor: "bottom" })
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
      inspirationMarkerRef.current?.remove();
      inspirationMarkerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [clearJourneyTimers, mapAttempt, selectDestination]);

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

  return (
    <main data-drawer-open={selected ? "true" : "false"} className="relative isolate h-[calc(100dvh-4rem)] min-h-[620px] overflow-hidden bg-[#bfe9f2] md:h-screen">
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

      {helpOpen ? (
        <aside className="absolute right-4 top-20 z-30 w-[min(320px,calc(100%-2rem))] rounded-[20px] bg-card/95 p-4 text-sm leading-6 shadow-xl backdrop-blur sm:right-6 sm:top-24">
          <p className="font-bold">Explore the map</p>
          <p className="mt-1 text-muted-foreground">Choose a named demo destination, or click anywhere to create an unverified inspiration that lasts only for this session.</p>
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

      <section className={`absolute bottom-4 left-4 z-20 w-[min(420px,calc(100%-2rem))] rounded-[24px] bg-card/95 p-5 shadow-[0_20px_60px_#082f3f40] backdrop-blur sm:bottom-6 sm:left-6 ${selected ? "hidden sm:block" : ""}`}>
        <div className="flex items-center gap-2 text-primary">
          <Sparkles aria-hidden="true" className="size-4" />
          <p className="text-[11px] font-black uppercase tracking-[0.14em]">Where should we go next?</p>
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-[-0.045em]">Explore the world</h1>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">Pick a marker or use the accessible destination list.</p>
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Destination suggestions">
          {destinations.map((destination) => (
            <button
              key={destination.name}
              type="button"
              onClick={() => selectDestination(destination)}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-full border bg-background px-3 text-sm font-bold transition hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30"
            >
              <MapPin aria-hidden="true" className="size-3.5" /> {destination.name}
            </button>
          ))}
        </div>
      </section>

      {selected ? (
        <aside className="absolute inset-x-0 bottom-0 z-30 max-h-[70dvh] overflow-y-auto rounded-t-[24px] bg-card/95 p-5 shadow-[0_20px_60px_#082f3f55] backdrop-blur sm:inset-x-auto sm:bottom-auto sm:right-6 sm:top-28 sm:w-[min(360px,calc(100%-2rem))] sm:rounded-[24px]">
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
        </aside>
      ) : null}
    </main>
  );
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
