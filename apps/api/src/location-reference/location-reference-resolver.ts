import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type LocationReference =
  | {
      outcome: "REFERENCE";
      country: string;
      countryCode: string | null;
      admin1: string | null;
      admin1Code: string | null;
      nearestCity: string | null;
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
  properties: { ADMIN?: string; ISO_A2?: string };
  bbox?: [number, number, number, number];
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: Position[][] | Position[][][] };
};
type Admin1Feature = {
  properties: { name?: string; iso_3166_2?: string; iso_a2?: string };
  bbox?: [number, number, number, number];
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: Position[][] | Position[][][] };
};
type City = { name: string; countryCode: string; latitude: number; longitude: number };
type Manifest = { version: string; checkedAt: string };

const SOURCE = "Natural Earth + GeoNames" as const;
const MAX_CITY_DISTANCE_KM = 75;
const MIN_MAJOR_CITY_POPULATION = 50_000;

export class LocationReferenceResolver {
  private readonly countries: CountryFeature[];
  private readonly citiesByCountry: Map<string, City[]>;
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
    this.admin1ByCountry = new Map();
    for (const city of cities) {
      const grouped = this.citiesByCountry.get(city.countryCode) ?? [];
      grouped.push(city);
      this.citiesByCountry.set(city.countryCode, grouped);
    }
    for (const region of admin1) {
      const countryCode = normalizedCountryCode(region.properties.iso_a2);
      if (!countryCode) continue;
      const grouped = this.admin1ByCountry.get(countryCode) ?? [];
      grouped.push(region);
      this.admin1ByCountry.set(countryCode, grouped);
    }
  }

  resolve(latitude: number, longitude: number): LocationReference {
    const country = this.countries.find((feature) => containsCoordinate(feature, longitude, latitude));
    if (!country?.properties.ADMIN) return this.noReference();

    const countryCode = normalizedCountryCode(country.properties.ISO_A2);
    const region = countryCode
      ? (this.admin1ByCountry.get(countryCode) ?? []).find((feature) => containsCoordinate(feature, longitude, latitude))
      : undefined;
    const city = countryCode ? nearestCity(this.citiesByCountry.get(countryCode) ?? [], latitude, longitude) : null;
    const cityReference = city && city.distanceKm <= MAX_CITY_DISTANCE_KM ? city : null;
    return {
      outcome: "REFERENCE",
      country: country.properties.ADMIN,
      countryCode,
      admin1: region?.properties.name ?? null,
      admin1Code: region?.properties.iso_3166_2 ?? null,
      nearestCity: cityReference?.name ?? null,
      distanceKm: cityReference ? roundDistance(cityReference.distanceKm) : null,
      source: SOURCE,
      datasetVersion: this.manifest.version,
      checkedAt: this.manifest.checkedAt,
      isTravelFact: false,
    };
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
  const bundledCountriesPath = resolve(process.cwd(), "data/location-reference/countries.geojson");
  const developmentCountriesPath = resolve(process.cwd(), "../web/public/map-data/natural-earth-admin-0.geojson");
  const countriesPath = process.env.LOCATION_REFERENCE_COUNTRIES_PATH
    ?? (existsSync(bundledCountriesPath) ? bundledCountriesPath : developmentCountriesPath);
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
    return [{ name: fields[1], countryCode, latitude, longitude }];
  });
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
