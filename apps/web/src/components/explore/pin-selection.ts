import type { LocationReferenceResponse } from "@/lib/api/contracts";

export const REGION_SELECTION_MIN_ZOOM = 4.5;
// Cities appear — and a click resolves to a city rather than its region or
// country — from this zoom up. It was 6.5, which meant a traveller had to zoom
// in hard before any city showed or could be pinned; 5.5 gives cities their
// own full zoom band above regions.
export const CITY_SELECTION_MIN_ZOOM = 5.5;

export type PinGranularity = "country" | "region" | "city";

export type PinSelection = {
  granularity: PinGranularity;
  key: string;
  name: string;
  coordinates: [number, number];
  cityName?: string;
};

export type AdministrativeCenter = {
  kind: "country" | "region";
  localizedName: string;
  aliases: string[];
  coordinates: [number, number];
};

type PlaceFeature = GeoJSON.Feature<GeoJSON.Point>;
type Reference = Extract<LocationReferenceResponse, { outcome: "REFERENCE" }>;

const GEOGRAPHY_LABEL_DATA_URL = "/map-data/geography-labels.geojson";
const centerPromises = new Map<string, Promise<AdministrativeCenter[]>>();

export function pinGranularityForZoom(zoom: number): PinGranularity {
  if (zoom >= CITY_SELECTION_MIN_ZOOM) return "city";
  if (zoom >= REGION_SELECTION_MIN_ZOOM) return "region";
  return "country";
}

export function loadAdministrativeCenters(locale: string): Promise<AdministrativeCenter[]> {
  const language = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  const existing = centerPromises.get(language);
  if (existing) return existing;
  const request = fetch(GEOGRAPHY_LABEL_DATA_URL)
    .then(async (response) => {
      if (!response.ok) throw new Error(`Administrative center request failed (${response.status})`);
      return response.json() as Promise<GeoJSON.FeatureCollection<GeoJSON.Point>>;
    })
    .then((collection) => administrativeCentersFromFeatures(collection.features, language));
  centerPromises.set(language, request);
  return request;
}

export function administrativeCentersFromFeatures(features: PlaceFeature[], locale: string): AdministrativeCenter[] {
  return features.flatMap((feature) => {
    if (feature.geometry.type !== "Point") return [];
    const properties = feature.properties as Record<string, unknown> | null;
    const className = typeof properties?.class === "string" ? properties.class : "";
    if (className !== "country" && className !== "region" && className !== "state" && className !== "province") return [];
    const names = [properties?.name, properties?.name_en, properties?.name_zh, properties?.["name:en"], properties?.["name:zh"]]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (names.length === 0) return [];
    const localizedName = locale.startsWith("zh")
      ? names.find((name) => /[\u3400-\u9fff]/u.test(name)) ?? names[0]
      : (typeof properties?.name_en === "string" ? properties.name_en.trim() : names[0]);
    return [{
      kind: className === "country" ? "country" as const : "region" as const,
      localizedName,
      aliases: [...new Set(names.map(normalizeName))],
      coordinates: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]] as [number, number],
    }];
  });
}

export function pinSelectionForReference(
  requested: PinGranularity,
  reference: Reference,
  clickedCoordinates: [number, number],
  centers: AdministrativeCenter[],
): PinSelection {
  if (requested === "city" && reference.nearestCity && reference.nearestCityCoordinates) {
    return {
      granularity: "city",
      key: `city:${reference.countryCode ?? "unknown"}:${normalizeName(reference.nearestCity)}`,
      name: reference.nearestCity,
      coordinates: clickedCoordinates,
      cityName: reference.nearestCity,
    };
  }

  if (requested !== "country" && reference.admin1) {
    const center = closestMatchingCenter(centers, "region", reference.admin1, clickedCoordinates);
    return {
      granularity: "region",
      key: `region:${reference.countryCode ?? normalizeName(reference.country)}:${reference.admin1Code ?? normalizeName(reference.admin1)}`,
      name: center?.localizedName ?? reference.admin1,
      coordinates: clickedCoordinates,
    };
  }

  const center = closestMatchingCenter(centers, "country", reference.country, clickedCoordinates);
  return {
    granularity: "country",
    key: `country:${reference.countryCode ?? normalizeName(reference.country)}`,
    name: center?.localizedName ?? reference.country,
    coordinates: clickedCoordinates,
  };
}

function closestMatchingCenter(
  centers: AdministrativeCenter[],
  kind: AdministrativeCenter["kind"],
  name: string,
  origin: [number, number],
) {
  const normalized = normalizeName(name);
  return centers
    .filter((center) => center.kind === kind && center.aliases.includes(normalized))
    .reduce<AdministrativeCenter | null>((closest, candidate) => {
      if (!closest) return candidate;
      return squaredDistance(candidate.coordinates, origin) < squaredDistance(closest.coordinates, origin) ? candidate : closest;
    }, null);
}

function squaredDistance(left: [number, number], right: [number, number]) {
  const longitude = left[0] - right[0];
  const latitude = left[1] - right[1];
  return longitude * longitude + latitude * latitude;
}

function normalizeName(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}
