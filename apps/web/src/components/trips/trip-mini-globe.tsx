"use client";

import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

import { loadCityCatalog, type CatalogCity } from "@/components/explore/city-catalog";
import { useOptionalTravelApi } from "@/lib/query/provider";
import { useRouter } from "@/i18n/navigation";
import { solidifyGlobeStyle } from "@/components/explore/map-surface-style";

const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";

/** One marker on the mini globe: a country plus the places rolled into it. */
export type CountryPin = {
  key: string;
  name: string;
  coordinates: [number, number];
  places: string[];
};

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

/**
 * Great-circle distance in kilometres. Used only to decide which country a
 * resolved city belongs to, so the earth-radius approximation is ample.
 */
export function distanceKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = toRadians(b[1] - a[1]);
  const dLon = toRadians(b[0] - a[0]);
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Resolves a place name to coordinates using the shipped city catalogue.
 * Names we cannot resolve are dropped rather than guessed at.
 */
export function resolvePlaceCoordinates(
  places: string[],
  cities: CatalogCity[],
): { place: string; city: CatalogCity }[] {
  const byAlias = new Map<string, CatalogCity>();
  for (const city of cities) {
    for (const alias of [city.name, city.localizedName, ...city.aliases]) {
      const key = normalize(alias);
      if (key && !byAlias.has(key)) byAlias.set(key, city);
    }
  }

  return places.flatMap((place) => {
    const city = byAlias.get(normalize(place));
    return city ? [{ place, city }] : [];
  });
}

/**
 * Groups resolved places by the country the server reported for their
 * coordinates, producing one pin per country labelled with the country name.
 *
 * The country must come from the location-reference endpoint (Natural Earth +
 * GeoNames). Deriving it client-side from label anchors does not work: country
 * labels are anchors rather than polygons, so a microstate beats its large
 * neighbour and Shanghai resolves to South Korea. When the lookup returns no
 * country the place keeps its own city-labelled pin instead of asserting one.
 */
export function groupResolvedPlacesByCountry(
  resolved: { place: string; city: CatalogCity; country: { name: string; code: string | null } | null }[],
): CountryPin[] {
  const merged = new Map<string, CountryPin>();

  for (const entry of resolved) {
    const key = entry.country
      ? `country:${entry.country.code ?? entry.country.name}`
      : `city:${entry.city.key}`;

    const existing = merged.get(key);
    if (existing) {
      if (!existing.places.includes(entry.place)) existing.places.push(entry.place);
      // Anchor a country pin at the mean of the cities rolled into it.
      const count = existing.places.length;
      existing.coordinates = [
        existing.coordinates[0] + (entry.city.coordinates[0] - existing.coordinates[0]) / count,
        existing.coordinates[1] + (entry.city.coordinates[1] - existing.coordinates[1]) / count,
      ];
      continue;
    }

    merged.set(key, {
      key,
      name: entry.country ? entry.country.name : entry.city.localizedName,
      coordinates: [...entry.city.coordinates] as [number, number],
      places: [entry.place],
    });
  }

  return [...merged.values()];
}

/** Camera that frames every pin, falling back to a whole-globe view. */
export function framingCamera(pins: CountryPin[]): { center: [number, number]; zoom: number } {
  if (pins.length === 0) return { center: [10, 20], zoom: 0.1 };
  if (pins.length === 1) return { center: pins[0].coordinates, zoom: 1.6 };

  // Average through unit vectors so pins either side of the antimeridian do
  // not average back to the middle of the map.
  let x = 0;
  let y = 0;
  let z = 0;
  for (const pin of pins) {
    const lon = toRadians(pin.coordinates[0]);
    const lat = toRadians(pin.coordinates[1]);
    x += Math.cos(lat) * Math.cos(lon);
    y += Math.cos(lat) * Math.sin(lon);
    z += Math.sin(lat);
  }
  x /= pins.length;
  y /= pins.length;
  z /= pins.length;
  const center: [number, number] = [
    (Math.atan2(y, x) * 180) / Math.PI,
    (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI,
  ];

  const spread = Math.max(...pins.map((pin) => distanceKm(center, pin.coordinates)));
  const zoom = spread > 6000 ? 0.1 : spread > 3000 ? 0.7 : spread > 1200 ? 1.2 : 1.8;
  return { center, zoom };
}

async function loadGlobeStyle(): Promise<StyleSpecification> {
  const response = await fetch(MAP_STYLE_URL);
  if (!response.ok) throw new Error(`Map style request failed (${response.status})`);
  const style = await response.json() as StyleSpecification;
  return solidifyGlobeStyle({ ...style, projection: { type: "globe" } });
}

/**
 * A scaled-down copy of the explore globe for the trip workspace. It is inert
 * — no scroll, drag or keyboard camera — so it reads as a preview of the
 * selected plan rather than a second map to operate.
 */
export function TripMiniGlobe({ places, fallbackLabel, tripId }: { places: string[]; fallbackLabel: string; tripId: string }) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("trips.workspace");
  const openPinLabel = t("openPinAria", { name: "{name}" });
  const travelApi = useOptionalTravelApi();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [pins, setPins] = useState<CountryPin[]>([]);
  const [failed, setFailed] = useState(false);

  const placeKey = useMemo(() => places.join("|"), [places]);

  useEffect(() => {
    let active = true;

    void (async () => {
      const names = placeKey ? placeKey.split("|") : [];
      if (names.length === 0) {
        if (active) setPins([]);
        return;
      }

      try {
        const cities = await loadCityCatalog(locale);
        const resolved = resolvePlaceCoordinates(names, cities);

        // Ask the server which country each coordinate falls in. Without a
        // client, or when a lookup fails, the pin falls back to its city name.
        const withCountry = await Promise.all(resolved.map(async (entry) => {
          if (!travelApi) return { ...entry, country: null };
          try {
            const reference = await travelApi.getLocationReference({
              latitude: entry.city.coordinates[1],
              longitude: entry.city.coordinates[0],
            });
            if (reference.outcome !== "REFERENCE") return { ...entry, country: null };
            return { ...entry, country: { name: reference.country, code: reference.countryCode } };
          } catch {
            return { ...entry, country: null };
          }
        }));

        if (active) setPins(groupResolvedPlacesByCountry(withCountry));
      } catch {
        if (active) setPins([]);
      }
    })();

    return () => { active = false; };
  }, [locale, placeKey, travelApi]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let active = true;
    let map: MapLibreMap | null = null;
    const markers: { remove: () => void }[] = [];

    void (async () => {
      try {
        const [maplibregl, style] = await Promise.all([import("maplibre-gl"), loadGlobeStyle()]);
        if (!active) return;

        const camera = framingCamera(pins);
        map = new maplibregl.Map({
          container,
          style,
          center: camera.center,
          zoom: camera.zoom,
          attributionControl: false,
          // Inert preview: every interaction handler stays off.
          interactive: false,
        });
        mapRef.current = map;

        for (const pin of pins) {
          // The pin is the only interactive thing on this preview; the map
          // itself stays inert. Clicking opens the full globe framed on that
          // country, carrying the trip id so the viewer can come back.
          const button = document.createElement("button");
          button.type = "button";
          button.className = "wanderly-mini-pin";
          button.setAttribute("aria-label", openPinLabel.replace("{name}", pin.name));
          const label = document.createElement("span");
          label.textContent = pin.name;
          button.append(label);
          button.addEventListener("click", () => {
            const params = new URLSearchParams({
              focusLat: String(pin.coordinates[1]),
              focusLng: String(pin.coordinates[0]),
              focusZoom: "3.4",
              focusLabel: pin.name,
              fromTrip: tripId,
            });
            router.push(`/home?${params.toString()}` as Parameters<typeof router.push>[0]);
          });
          markers.push(new maplibregl.Marker({ element: button, anchor: "bottom" })
            .setLngLat(pin.coordinates)
            .addTo(map));
        }
      } catch {
        if (active) setFailed(true);
      }
    })();

    return () => {
      active = false;
      for (const marker of markers) marker.remove();
      map?.remove();
      mapRef.current = null;
    };
  }, [openPinLabel, pins, router, tripId]);

  return (
    <div className="relative h-[150px] overflow-hidden bg-[var(--w-space)]">
      <div ref={containerRef} className="size-full" aria-hidden="true" />
      {failed ? (
        <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(130deg,var(--w-primary),var(--w-info))]" />
      ) : null}
      <span className="absolute bottom-3 left-[15px] z-[1] max-w-[calc(100%-30px)] truncate bg-card px-[7px] py-[5px] text-[11px] font-extrabold text-[var(--w-ink)] wanderly-edge-thin wanderly-r-xs">
        {pins.length > 0 ? pins.map((pin) => pin.name).join(" · ") : fallbackLabel}
      </span>
    </div>
  );
}
