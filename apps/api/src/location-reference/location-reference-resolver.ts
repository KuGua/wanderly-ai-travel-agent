import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DestinationReference } from "../types/domain.js";

export type LocationReference =
  | {
      outcome: "REFERENCE";
      country: string;
      countryCode: string | null;
      admin1: string | null;
      admin1Code: string | null;
      nearestCity: string | null;
      nearestCityCoordinates: { latitude: number; longitude: number } | null;
      distanceKm: number | null;
      source: "Natural Earth + GeoNames";
      datasetVersion: string;
      checkedAt: string;
      isTravelFact: false;
    }
  | {
      outcome: "NO_REFERENCE";
      source: "Natural Earth + GeoNames";
      datasetVersion: string;
      checkedAt: string;
      isTravelFact: false;
    };

type Position = [number, number];
type CountryFeature = {
  properties: {
    ADMIN?: string;
    ISO_A2?: string;
    ADM0_A3?: string;
    NAME_EN?: string;
    NAME_ZH?: string;
  };
  bbox?: [number, number, number, number];
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: Position[][] | Position[][][] };
};
type Admin1Feature = {
  properties: { name?: string; name_zh?: string; iso_3166_2?: string; iso_a2?: string };
  bbox?: [number, number, number, number];
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: Position[][] | Position[][][] };
};
type City = {
  name: string;
  alternateNames?: string[];
  countryCode: string;
  latitude: number;
  longitude: number;
  population?: number;
  featureCode?: string;
  admin1Code?: string;
  admin2Code?: string;
};
type Manifest = { version: string; checkedAt: string };

const SOURCE = "Natural Earth + GeoNames" as const;
const MAX_CITY_DISTANCE_KM = 75;
// Natural Earth Admin 0 omits small offshore and reclaimed land (for example
// Sentosa off Singapore). A click there is inside no country polygon, so fall
// back to the nearest coast within this tolerance instead of claiming the point
// has no reference. Open water stays NO_REFERENCE.
const NEAREST_COUNTRY_TOLERANCE_KM = 10;
const KM_PER_DEGREE_LATITUDE = 111.32;
const MIN_MAJOR_CITY_POPULATION = 50_000;
const CITY_LEVEL_FEATURE_CODES = new Set(["PPL", "PPLA", "PPLA2", "PPLC"]);
const AUTHORITY_FEATURE_CODES = new Set(["PPLA", "PPLA2", "PPLC"]);

export class LocationReferenceResolver {
  private readonly countries: CountryFeature[];
  private readonly citiesByCountry: Map<string, City[]>;
  private readonly citiesByName: Map<string, City[]>;
  private readonly countryCodesByName: Map<string, string>;
  private readonly admin1ByCountry: Map<string, Admin1Feature[]>;
  private readonly manifest: Manifest;

  constructor(
    countries: CountryFeature[],
    cities: City[],
    admin1: Admin1Feature[],
    manifest: Manifest,
  ) {
    this.countries = countries;
    this.manifest = manifest;
    this.citiesByCountry = new Map();
    this.citiesByName = new Map();
    this.countryCodesByName = new Map();
    this.admin1ByCountry = new Map();
    for (const country of countries) {
      const countryCode = normalizedCountryCode(country.properties.ISO_A2);
      if (!countryCode) continue;
      for (const alias of [
        country.properties.ADMIN,
        country.properties.ISO_A2,
        country.properties.ADM0_A3,
        country.properties.NAME_EN,
        country.properties.NAME_ZH,
      ]) {
        if (alias) this.countryCodesByName.set(normalizedName(alias), countryCode);
      }
    }
    for (const city of cityLevelProjection(cities)) {
      const grouped = this.citiesByCountry.get(city.countryCode) ?? [];
      grouped.push(city);
      this.citiesByCountry.set(city.countryCode, grouped);
      for (const alias of [city.name, ...(city.alternateNames ?? [])]) {
        const key = normalizedName(alias);
        if (!key) continue;
        const named = this.citiesByName.get(key) ?? [];
        named.push(city);
        this.citiesByName.set(key, named);
      }
    }
    for (const region of admin1) {
      const countryCode = normalizedCountryCode(region.properties.iso_a2);
      if (!countryCode) continue;
      const grouped = this.admin1ByCountry.get(countryCode) ?? [];
      grouped.push(region);
      this.admin1ByCountry.set(countryCode, grouped);
    }
  }

  /**
   * `language` picks which name the dataset already carries, nothing more —
   * the geometry decides *which* place, and only its label changes. Anything
   * other than Chinese keeps the English names, and a place with no Chinese
   * entry keeps its English one rather than blanking.
   */
  resolve(latitude: number, longitude: number, language?: string): LocationReference {
    const zh = language?.toLowerCase().startsWith("zh") ?? false;
    const country = this.countries.find((feature) => containsCoordinate(feature, longitude, latitude))
      ?? nearestCountryWithinTolerance(this.countries, longitude, latitude);
    if (!country?.properties.ADMIN) return this.noReference();

    const countryCode = normalizedCountryCode(country.properties.ISO_A2);
    const region = countryCode
      ? (this.admin1ByCountry.get(countryCode) ?? []).find((feature) => containsCoordinate(feature, longitude, latitude))
      : undefined;
    const city = countryCode ? nearestCity(this.citiesByCountry.get(countryCode) ?? [], latitude, longitude) : null;
    const cityReference = city && city.distanceKm <= MAX_CITY_DISTANCE_KM ? city : null;
    return {
      outcome: "REFERENCE",
      country: (zh ? country.properties.NAME_ZH : undefined)
        ?? country.properties.ADMIN,
      countryCode,
      admin1: (zh ? region?.properties.name_zh : undefined)
        ?? region?.properties.name
        ?? null,
      admin1Code: region?.properties.iso_3166_2 ?? null,
      nearestCity: cityReference?.name ?? null,
      nearestCityCoordinates: cityReference
        ? { latitude: cityReference.latitude, longitude: cityReference.longitude }
        : null,
      distanceKm: cityReference ? roundDistance(cityReference.distanceKm) : null,
      source: SOURCE,
      datasetVersion: this.manifest.version,
      checkedAt: this.manifest.checkedAt,
      isTravelFact: false,
    };
  }

  /** Resolve a planner-owned city label into a provider-safe reference. */
  resolveDestinationReference(params: {
    destinationId: string;
    cityName: string;
    countryHint?: string | null;
  }): DestinationReference | null {
    const matches = this.citiesByName.get(normalizedName(params.cityName)) ?? [];
    const hintedCountryCode = params.countryHint
      ? this.countryCodesByName.get(normalizedName(params.countryHint)) ?? null
      : null;
    const narrowed = hintedCountryCode
      ? matches.filter((city) => city.countryCode === hintedCountryCode)
      : matches;
    if (narrowed.length === 0 || new Set(narrowed.map((city) => city.countryCode)).size !== 1) {
      return null;
    }
    const city = [...narrowed].sort((left, right) => (right.population ?? 0) - (left.population ?? 0))[0];
    return {
      destinationId: params.destinationId,
      cityName: city.name,
      countryCode: city.countryCode,
      latitude: city.latitude,
      longitude: city.longitude,
    };
  }

  /**
   * Answers only whether text names a country in the controlled reference
   * data. This is deliberately separate from destination resolution: a
   * country is useful exploration context, but never a planner destination
   * because it cannot safely identify one city, airport, or provider query.
   */
  isKnownCountryName(value: string): boolean {
    return this.countryCodesByName.has(normalizedName(value));
  }

  private noReference(): LocationReference {
    return {
      outcome: "NO_REFERENCE",
      source: SOURCE,
      datasetVersion: this.manifest.version,
      checkedAt: this.manifest.checkedAt,
      isTravelFact: false,
    };
  }
}

let defaultResolver: LocationReferenceResolver | undefined;

export function getLocationReferenceResolver(): LocationReferenceResolver {
  if (defaultResolver) return defaultResolver;
  const countriesPath = process.env.LOCATION_REFERENCE_COUNTRIES_PATH
    ?? resolve(process.cwd(), "data/location-reference/countries.geojson");
  const countries = JSON.parse(readFileSync(countriesPath, "utf8")) as { features: CountryFeature[] };
  const admin1 = JSON.parse(readFileSync(resolve(process.cwd(), "data/location-reference/admin1.geojson"), "utf8")) as { features: Admin1Feature[] };
  const cities = parseGeoNamesCities(readFileSync(resolve(process.cwd(), "data/location-reference/cities5000.txt"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "data/location-reference/source-manifest.json"), "utf8")) as Manifest;
  defaultResolver = new LocationReferenceResolver(countries.features, cities, admin1.features.map(withBbox), manifest);
  return defaultResolver;
}

function normalizedCountryCode(value: string | undefined): string | null {
  return value && /^[A-Z]{2}$/.test(value) ? value : null;
}

function containsCoordinate(feature: CountryFeature | Admin1Feature, longitude: number, latitude: number): boolean {
  if (feature.bbox && (longitude < feature.bbox[0] || longitude > feature.bbox[2] || latitude < feature.bbox[1] || latitude > feature.bbox[3])) return false;
  const polygons = feature.geometry.type === "Polygon"
    ? [feature.geometry.coordinates as Position[][]]
    : feature.geometry.coordinates as Position[][][];
  return polygons.some((polygon) => pointInPolygon([longitude, latitude], polygon));
}

function parseGeoNamesCities(text: string): City[] {
  return text.split("\n").flatMap((line) => {
    const fields = line.split("\t");
    const latitude = Number(fields[4]);
    const longitude = Number(fields[5]);
    const countryCode = fields[8];
    const population = Number(fields[14]);
    const featureCode = fields[7];
    const isAdministrativeSeat = /^PPLA|^PPLC/.test(featureCode);
    if (!fields[1] || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !/^[A-Z]{2}$/.test(countryCode)
      || (!isAdministrativeSeat && population < MIN_MAJOR_CITY_POPULATION)) return [];
    return [{
      name: fields[1],
      alternateNames: [fields[2], ...(fields[3]?.split(",") ?? [])].filter(Boolean),
      countryCode,
      latitude,
      longitude,
      population: Number.isFinite(population) ? population : 0,
      featureCode,
      admin1Code: fields[10] || undefined,
      admin2Code: fields[11] || undefined,
    }];
  });
}

function normalizedName(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").trim().toLocaleLowerCase("en");
}

function cityLevelProjection(cities: City[]): City[] {
  const authorityByAdminArea = new Map<string, City[]>();
  const authorityByAdmin1 = new Map<string, City[]>();
  for (const city of cities) {
    if (!city.featureCode || !AUTHORITY_FEATURE_CODES.has(city.featureCode)) continue;
    const admin1Key = city.admin1Code ? `${city.countryCode}:${city.admin1Code}` : null;
    if (admin1Key) {
      const admin1Seats = authorityByAdmin1.get(admin1Key) ?? [];
      admin1Seats.push(city);
      authorityByAdmin1.set(admin1Key, admin1Seats);
    }
    const key = adminAreaKey(city);
    if (!key) continue;
    const seats = authorityByAdminArea.get(key) ?? [];
    seats.push(city);
    authorityByAdminArea.set(key, seats);
  }

  return cities.filter((city) => {
    // Tests and callers that provide no GeoNames metadata already represent a city.
    if (!city.featureCode) return true;
    if (!CITY_LEVEL_FEATURE_CODES.has(city.featureCode)) return false;
    if (city.featureCode !== "PPL") return true;

    const key = adminAreaKey(city);
    if (key) return !authorityByAdminArea.has(key);
    if (!city.admin1Code) return true;
    const admin1Seats = authorityByAdmin1.get(`${city.countryCode}:${city.admin1Code}`) ?? [];
    return !admin1Seats.some((seat) =>
      haversineKm(city.latitude, city.longitude, seat.latitude, seat.longitude) <= MAX_CITY_DISTANCE_KM);
  });
}

function adminAreaKey(city: City): string | null {
  if (!city.admin1Code || !city.admin2Code) return null;
  return `${city.countryCode}:${city.admin1Code}:${city.admin2Code}`;
}

function withBbox(feature: Admin1Feature): Admin1Feature {
  if (feature.bbox) return feature;
  const positions = feature.geometry.type === "Polygon"
    ? feature.geometry.coordinates.flat() as Position[]
    : feature.geometry.coordinates.flat(2) as Position[];
  let minLongitude = Infinity;
  let minLatitude = Infinity;
  let maxLongitude = -Infinity;
  let maxLatitude = -Infinity;
  for (const [longitude, latitude] of positions) {
    minLongitude = Math.min(minLongitude, longitude);
    minLatitude = Math.min(minLatitude, latitude);
    maxLongitude = Math.max(maxLongitude, longitude);
    maxLatitude = Math.max(maxLatitude, latitude);
  }
  return { ...feature, bbox: [minLongitude, minLatitude, maxLongitude, maxLatitude] };
}

function nearestCountryWithinTolerance(
  countries: CountryFeature[],
  longitude: number,
  latitude: number,
): CountryFeature | undefined {
  const longitudeKmPerDegree = Math.max(KM_PER_DEGREE_LATITUDE * Math.cos(latitude * (Math.PI / 180)), 1e-6);
  const latitudeSlack = NEAREST_COUNTRY_TOLERANCE_KM / KM_PER_DEGREE_LATITUDE;
  const longitudeSlack = NEAREST_COUNTRY_TOLERANCE_KM / longitudeKmPerDegree;
  let nearest: CountryFeature | undefined;
  let nearestDistanceKm = NEAREST_COUNTRY_TOLERANCE_KM;
  for (const feature of countries) {
    if (!feature.properties.ADMIN) continue;
    if (feature.bbox && (longitude < feature.bbox[0] - longitudeSlack || longitude > feature.bbox[2] + longitudeSlack
      || latitude < feature.bbox[1] - latitudeSlack || latitude > feature.bbox[3] + latitudeSlack)) continue;
    const distanceKm = distanceToGeometryKm(feature.geometry, longitude, latitude, longitudeKmPerDegree);
    if (distanceKm < nearestDistanceKm) {
      nearest = feature;
      nearestDistanceKm = distanceKm;
    }
  }
  return nearest;
}

function distanceToGeometryKm(
  geometry: CountryFeature["geometry"],
  longitude: number,
  latitude: number,
  longitudeKmPerDegree: number,
): number {
  const polygons = geometry.type === "Polygon"
    ? [geometry.coordinates as Position[][]]
    : geometry.coordinates as Position[][][];
  let nearestKm = Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const distanceKm = distanceToSegmentKm(
          ring[previous], ring[index], longitude, latitude, longitudeKmPerDegree,
        );
        if (distanceKm < nearestKm) nearestKm = distanceKm;
      }
    }
  }
  return nearestKm;
}

function distanceToSegmentKm(
  [startLongitude, startLatitude]: Position,
  [endLongitude, endLatitude]: Position,
  longitude: number,
  latitude: number,
  longitudeKmPerDegree: number,
): number {
  // Local equirectangular projection: exact enough at the 10 km tolerance scale.
  const pointX = longitude * longitudeKmPerDegree;
  const pointY = latitude * KM_PER_DEGREE_LATITUDE;
  const startX = startLongitude * longitudeKmPerDegree;
  const startY = startLatitude * KM_PER_DEGREE_LATITUDE;
  const endX = endLongitude * longitudeKmPerDegree;
  const endY = endLatitude * KM_PER_DEGREE_LATITUDE;
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
  const projection = segmentLengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((pointX - startX) * segmentX + (pointY - startY) * segmentY) / segmentLengthSquared));
  return Math.hypot(pointX - (startX + projection * segmentX), pointY - (startY + projection * segmentY));
}

function pointInPolygon(point: Position, rings: Position[][]): boolean {
  if (!pointInRing(point, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(point, ring));
}

function pointInRing([longitude, latitude]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [x1, y1] = ring[current];
    const [x2, y2] = ring[previous];
    const crosses = (y1 > latitude) !== (y2 > latitude)
      && longitude < ((x2 - x1) * (latitude - y1)) / (y2 - y1) + x1;
    if (crosses) inside = !inside;
  }
  return inside;
}

function nearestCity(cities: City[], latitude: number, longitude: number): (City & { distanceKm: number }) | null {
  let nearest: (City & { distanceKm: number }) | null = null;
  for (const city of cities) {
    const distanceKm = haversineKm(latitude, longitude, city.latitude, city.longitude);
    if (!nearest || distanceKm < nearest.distanceKm) nearest = { ...city, distanceKm };
  }
  return nearest;
}

function haversineKm(latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number): number {
  const radians = Math.PI / 180;
  const dLat = (latitudeB - latitudeA) * radians;
  const dLon = (longitudeB - longitudeA) * radians;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(latitudeA * radians) * Math.cos(latitudeB * radians) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function roundDistance(distanceKm: number): number {
  return Math.round(distanceKm * 10) / 10;
}
