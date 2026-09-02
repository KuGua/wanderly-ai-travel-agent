import { randomUUID } from "node:crypto";

import { metrics } from "../observability/metrics.js";
import type { DestinationReference } from "../types/domain.js";
import { openTripMapAccommodationResponseSchema } from "./opentripmap-accommodation-schemas.js";
import type {
  NormalizedPlaceCandidate,
  PlaceSearchProvider,
  ProviderResult,
} from "./types.js";

/**
 * OpenTripMap as the place-discovery source for "what is around this point".
 *
 * ORS answers a different question. It is a geocoder: it knows where a named
 * thing is, which is what adopting a TripPlace needs. Asked what is nearby it
 * returns whatever OpenStreetMap happens to hold at that coordinate, and
 * around a famous temple that is forty inscribed steles, signboards and water
 * basins before a single thing anyone would visit — all correct, none of it an
 * answer. OpenTripMap indexes the same places by kind and carries a
 * popularity rating, so "attractions near Sensō-ji" comes back as Asakusa
 * Shrine and Hōzōmon Gate.
 *
 * The two live side by side rather than one replacing the other: the executor
 * asks here first and falls back to ORS, so a search still works where
 * OpenTripMap has no coverage.
 */
const DEFAULT_BASE_URL = "https://api.opentripmap.com/0.1";
const SOURCE = "OpenTripMap" as const;
export const OPENTRIPMAP_ATTRIBUTION = "© OpenStreetMap contributors" as const;

/**
 * OpenTripMap's public taxonomy. `accomodations` is spelled that way upstream;
 * correcting it returns no data.
 */
const KINDS_BY_CATEGORY: Record<NormalizedPlaceCandidate["kind"], string> = {
  ATTRACTION: "interesting_places",
  RESTAURANT: "foods",
  HOTEL: "accomodations",
  TRANSPORT_HUB: "railway_stations,transport",
  OTHER: "interesting_places",
};

/**
 * Sightseeing indexes everything OSM marks, most of which is a plaque. The
 * rating separates the visitable from the merely mapped. Kinds that are not
 * saturated this way are taken unfiltered — a neighbourhood ramen shop is
 * rated 1 and is exactly what was asked for.
 */
const MIN_RATE_BY_CATEGORY: Partial<Record<NormalizedPlaceCandidate["kind"], number>> = {
  ATTRACTION: 2,
  OTHER: 2,
};

/** Upstream rejects a shorter one, and "拉面" is two. */
const MIN_AUTOSUGGEST_NAME_LENGTH = 3;

const MAX_RESULTS = 10;

export interface OpenTripMapPlaceProviderOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  defaultRadiusMeters: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function readOpenTripMapPlaceConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): OpenTripMapPlaceProviderOptions | null {
  const apiKey = env.OPENTRIPMAP_API_KEY?.trim();
  if (!apiKey) return null;
  // Opt-out rather than opt-in. A configured key with nothing reading it is
  // the state this provider exists to end; requiring a second flag to make
  // the key do anything reproduces it.
  if ((env.OPENTRIPMAP_PLACES_ENABLED ?? "true").trim().toLowerCase() !== "true") return null;
  const baseUrl = (env.OPENTRIPMAP_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/$/, "");
  if (new URL(baseUrl).protocol !== "https:") throw new Error("OPENTRIPMAP_BASE_URL must use HTTPS");
  const timeoutMs = Number(env.OPENTRIPMAP_TIMEOUT_MS ?? 8_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
    throw new Error("OPENTRIPMAP_TIMEOUT_MS must be an integer from 500 to 30000");
  }
  return { apiKey, baseUrl, timeoutMs, defaultRadiusMeters: 5_000 };
}

export class OpenTripMapPlaceProvider implements PlaceSearchProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: OpenTripMapPlaceProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async searchPlaces(params: {
    destination: DestinationReference;
    keyword: string;
    category: NormalizedPlaceCandidate["kind"];
    radiusMeters?: number;
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedPlaceCandidate[]>> {
    const startedAt = Date.now();
    const { latitude, longitude } = params.destination;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return this.record({ outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE" }, startedAt);
    }
    const radiusMeters = clampRadius(params.radiusMeters ?? this.options.defaultRadiusMeters);
    const kinds = KINDS_BY_CATEGORY[params.category];
    const keyword = params.keyword.trim();
    // The executor used to pass the category name as the traveller's words.
    const named = keyword.length >= MIN_AUTOSUGGEST_NAME_LENGTH
      && keyword.toUpperCase() !== params.category
      ? keyword
      : null;

    try {
      let places = named !== null
        ? await this.fetchPlaces("autosuggest", { latitude, longitude, radiusMeters, kinds, name: named }, params.signal)
        : [];
      // A name that matches nothing is not a report that the neighbourhood is
      // empty. It is far more often a word the index does not carry — a kind
      // rather than a name, or the traveller's own language — and what is
      // actually around them still answers the question they asked.
      if (places === null || places.length === 0) {
        places = await this.fetchPlaces("radius", {
          latitude, longitude, radiusMeters, kinds,
          minRate: MIN_RATE_BY_CATEGORY[params.category],
        }, params.signal);
        // A quiet town has nothing rated highly. Better an unranked list than
        // the claim that there is nothing there.
        if (places !== null && places.length === 0 && MIN_RATE_BY_CATEGORY[params.category] !== undefined) {
          places = await this.fetchPlaces("radius", { latitude, longitude, radiusMeters, kinds }, params.signal);
        }
      }
      if (places === null) return this.record({ outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" }, startedAt);

      const capturedAt = this.now().toISOString();
      const candidates = places
        .flatMap((place): NormalizedPlaceCandidate[] => {
          const displayName = place.name.trim();
          if (!displayName) return [];
          const distanceMeters = place.dist ?? null;
          if (distanceMeters !== null && distanceMeters > radiusMeters) return [];
          return [{
            candidateId: randomUUID(),
            displayName,
            kind: params.category,
            countryCode: params.destination.countryCode || null,
            cityName: params.destination.cityName || null,
            longitude: place.point.lon,
            latitude: place.point.lat,
            // OpenTripMap rates 1–3 and reserves 7 for cultural heritage, so
            // the scale is normalised against 7 rather than 3 — dividing by 3
            // saturated a listed shrine and an ordinary marker to the same
            // 1.0 and threw away the ranking this provider was chosen for.
            confidence: Math.min((place.rate ?? 0) / 7, 1),
            distanceKm: distanceMeters !== null ? distanceMeters / 1000 : null,
            needsUserConfirmation: (place.rate ?? 0) < 2,
            source: SOURCE,
            capturedAt,
          }];
        })
        // Notable first, then near. Distance alone puts the plaque you are
        // standing on above the shrine across the road.
        .sort((left, right) => (right.confidence - left.confidence)
          || ((left.distanceKm ?? Infinity) - (right.distanceKm ?? Infinity)))
        .slice(0, MAX_RESULTS);

      if (candidates.length === 0) return this.record({ outcome: "UNAVAILABLE", reason: "NO_RESULTS" }, startedAt);
      return this.record({
        outcome: "LIVE",
        data: candidates,
        source: `${SOURCE} (${OPENTRIPMAP_ATTRIBUTION})`,
        capturedAt,
      }, startedAt);
    } catch (error) {
      const reason = (error as { name?: string }).name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FAILURE";
      return this.record({ outcome: "UNAVAILABLE", reason }, startedAt);
    }
  }

  /** Returns the places, `[]` when there are none, or `null` when the call failed. */
  private async fetchPlaces(
    endpoint: "radius" | "autosuggest",
    query: { latitude: number; longitude: number; radiusMeters: number; kinds: string; name?: string; minRate?: number },
    signal?: AbortSignal,
  ): Promise<Array<{ name: string; kinds: string; dist?: number; rate?: number; point: { lat: number; lon: number } }> | null> {
    const url = new URL(`${this.options.baseUrl}/en/places/${endpoint}`);
    url.searchParams.set("radius", String(query.radiusMeters));
    url.searchParams.set("lat", String(query.latitude));
    url.searchParams.set("lon", String(query.longitude));
    url.searchParams.set("kinds", query.kinds);
    url.searchParams.set("limit", String(MAX_RESULTS * 3));
    url.searchParams.set("format", "json");
    url.searchParams.set("apikey", this.options.apiKey);
    if (query.name !== undefined) url.searchParams.set("name", query.name);
    if (query.minRate !== undefined) url.searchParams.set("rate", String(query.minRate));

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(url, { headers: { accept: "application/json" }, signal: composed });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 2_000_000) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
    // Upstream reports a rejected query as an object rather than a list.
    const parsed = openTripMapAccommodationResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  }

  private record<T extends ProviderResult<NormalizedPlaceCandidate[]>>(result: T, startedAt: number): T {
    const outcome = result.outcome === "LIVE" ? "live" : "unavailable";
    metrics.inc("place_provider_requests_total", {
      outcome,
      provider: "opentripmap",
      error_category: result.outcome === "LIVE" ? "none" : result.reason.toLowerCase(),
    });
    metrics.observe("place_provider_latency_ms", Date.now() - startedAt, { provider: "opentripmap", outcome });
    return result;
  }
}

function clampRadius(radiusMeters: number): number {
  return Math.min(Math.max(Math.round(radiusMeters), 100), 50_000);
}
