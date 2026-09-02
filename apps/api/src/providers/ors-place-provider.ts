import { randomUUID } from "node:crypto";
import type {
  NormalizedPlaceCandidate,
  PlaceSearchProvider,
  ProviderResult,
} from "./types.js";
import type { DestinationReference } from "../types/domain.js";
import { metrics } from "../observability/metrics.js";
import { observeExternalProviderFetch } from "../observability/external-provider.js";
import { orsGeocodingResponseSchema, type OrsGeocodingResponse } from "./ors-place-schemas.js";

export interface OrsPlaceProviderOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Required ORS attribution text. The ORS Terms of Service require this exact
 * string (or its latest equivalent) to appear on every UI surface that shows
 * data sourced from the ORS geocoding/directions APIs. Adding or paraphrasing
 * is not allowed.
 */
export const ORS_ATTRIBUTION = "© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors";

export function readOrsPlaceConfiguration(env: NodeJS.ProcessEnv = process.env): OrsPlaceProviderOptions | null {
  const apiKey = env.ORS_API_KEY?.trim();
  const baseUrl = (env.ORS_BASE_URL ?? "https://api.openrouteservice.org").trim();
  const timeoutMs = Number(env.ORS_PLACE_TIMEOUT_MS ?? 8000);
  if (!apiKey) return null;
  if (timeoutMs < 100 || timeoutMs > 30_000 || !Number.isInteger(timeoutMs)) {
    throw new Error("ORS_PLACE_TIMEOUT_MS must be an integer from 100 to 30000");
  }
  return { apiKey, baseUrl, timeoutMs };
}

export class OrsPlaceProvider implements PlaceSearchProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: OrsPlaceProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async searchPlaces(params: {
    destination: DestinationReference;
    keyword: string;
    category: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER";
    radiusMeters?: number;
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedPlaceCandidate[]>> {
    const start = Date.now();
    const capturedAt = this.now().toISOString();
    try {
      const anchored = Number.isFinite(params.destination.latitude)
        && Number.isFinite(params.destination.longitude);
      const radiusKm = params.radiusMeters !== undefined
        ? Math.min(Math.max(params.radiusMeters, 100), 50_000) / 1000
        : null;
      const text = searchTextFor(params.keyword, params.category);

      // Two questions, two endpoints. "What is near this point" is a reverse
      // lookup; "where is the nearest ramen" is a text search bounded to a
      // circle. Answering the first with the second is what produced venues
      // literally named "Attraction" and "Mane Attraction" — the category
      // word was being handed to a geocoder as the thing to find, so it
      // matched names rather than kinds, and any place whose name contained
      // the word outranked the temple the traveller was standing next to.
      const useReverse = anchored && text === null;
      let outcome = await this.fetchCandidates(
        useReverse
          ? this.reversePath(params, radiusKm)
          : this.searchPath(params, text ?? params.category, radiusKm, anchored),
        params, capturedAt, radiusKm,
      );
      if (outcome.kind === "error") return this.unavailable(outcome.reason, start);

      // A geocoder indexes names, so a keyword naming a kind rather than a
      // place — "景点", "sightseeing", even "temple" in a district that spells
      // it differently — legitimately matches nothing. Reporting NO_RESULTS
      // there says "there is nothing near you", which is both false and the
      // least useful thing to say. What is actually around the point is a
      // real answer to the question that was asked.
      // Only for a caller that gave a radius. That is what distinguishes
      // "what is around this point" from "find me the place called X" — and
      // adopting a nearby neighbour as the place someone searched for by name
      // would be a wrong answer rather than a helpful one.
      if (outcome.candidates.length === 0 && !useReverse && anchored && radiusKm !== null) {
        const nearby = await this.fetchCandidates(
          this.reversePath(params, radiusKm), params, capturedAt, radiusKm,
        );
        if (nearby.kind === "ok") outcome = nearby;
      }
      const candidates = outcome.candidates;
      if (candidates.length === 0) {
        return this.unavailable("NO_RESULTS", start);
      }
      this.record("LIVE", start);
      return {
        outcome: "LIVE",
        data: candidates,
        source: `ORS Geocoding (${ORS_ATTRIBUTION})`,
        capturedAt,
      };
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return this.unavailable("UPSTREAM_TIMEOUT", start);
      return this.unavailable("UPSTREAM_FAILURE", start);
    }
  }

  /** One request, parsed and normalized, or the reason it could not be. */
  private async fetchCandidates(
    path: string,
    params: {
      destination: DestinationReference;
      category: NormalizedPlaceCandidate["kind"];
      signal?: AbortSignal;
    },
    capturedAt: string,
    radiusKm: number | null,
  ): Promise<
    | { kind: "ok"; candidates: NormalizedPlaceCandidate[] }
    | { kind: "error"; reason: "RATE_LIMITED" | "UPSTREAM_FAILURE" | "INVALID_PROVIDER_RESPONSE" }
  > {
    const response = await this.request(path, params.signal);
    if (response.status === 429) return { kind: "error", reason: "RATE_LIMITED" };
    if (!response.ok) return { kind: "error", reason: "UPSTREAM_FAILURE" };
    let payload: OrsGeocodingResponse;
    try {
      const parsed = orsGeocodingResponseSchema.safeParse(await response.json());
      if (!parsed.success) return { kind: "error", reason: "INVALID_PROVIDER_RESPONSE" };
      payload = parsed.data;
    } catch {
      return { kind: "error", reason: "INVALID_PROVIDER_RESPONSE" };
    }
    const candidates: NormalizedPlaceCandidate[] = [];
    for (const feature of payload.features) {
      const normalized = normalizeFeature(
        feature, params.category, capturedAt, params.destination.countryCode,
      );
      if (!normalized) continue;
      // ORS treats the circle as a strong bias rather than a hard bound, so
      // it will still answer 1.7 km out for a 1.5 km request. A radius the
      // caller stated is a constraint, not a preference; a place outside it
      // is a wrong answer however good the name match.
      if (radiusKm !== null && Number.isFinite(normalized.distanceKm) && (normalized.distanceKm as number) > radiusKm) continue;
      candidates.push(normalized);
      if (candidates.length >= PLACE_RESULT_LIMIT) break;
    }
    return { kind: "ok", candidates };
  }

  /** What is actually around this point, nearest first. */
  private reversePath(
    params: { destination: DestinationReference; category: NormalizedPlaceCandidate["kind"] },
    radiusKm: number | null,
  ): string {
    const query = new URLSearchParams({
      api_key: this.options.apiKey,
      "point.lat": String(params.destination.latitude),
      "point.lon": String(params.destination.longitude),
      layers: categoryToLayer(params.category),
      size: String(PLACE_RESULT_LIMIT),
    });
    if (radiusKm !== null) query.set("boundary.circle.radius", String(radiusKm));
    return `/geocode/reverse?${query.toString()}`;
  }

  /** Where the nearest match for these words is. */
  private searchPath(
    params: { destination: DestinationReference; category: NormalizedPlaceCandidate["kind"] },
    text: string,
    radiusKm: number | null,
    anchored: boolean,
  ): string {
    const query = new URLSearchParams({
      api_key: this.options.apiKey,
      text,
      layers: categoryToLayer(params.category),
      size: String(PLACE_RESULT_LIMIT),
    });
    // ORS rejects an empty `boundary.country` with 400 rather than
    // ignoring it. Callers that anchor a search on coordinates alone have
    // no country to give, so the filter is only applied when there is one.
    if (params.destination.countryCode.trim().length > 0) {
      query.set("boundary.country", params.destination.countryCode);
    }
    if (anchored) {
      // `focus.point` only ranks; `boundary.circle` is what keeps a global
      // name match from being returned as a neighbour.
      query.set("focus.point.lat", String(params.destination.latitude));
      query.set("focus.point.lon", String(params.destination.longitude));
      if (radiusKm !== null) {
        query.set("boundary.circle.lat", String(params.destination.latitude));
        query.set("boundary.circle.lon", String(params.destination.longitude));
        query.set("boundary.circle.radius", String(radiusKm));
      }
    }
    return `/geocode/search?${query.toString()}`;
  }

  private async request(path: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return observeExternalProviderFetch(
      { provider: "openrouteservice", operation: "place.search", method: "GET" },
      () => this.fetchImpl(`${this.options.baseUrl}${path}`, { signal: composed }),
    );
  }

  private unavailable(
    reason: Extract<ProviderResult<NormalizedPlaceCandidate[]>, { outcome: "UNAVAILABLE" }>["reason"],
    start: number,
  ): ProviderResult<NormalizedPlaceCandidate[]> {
    this.record(reason, start);
    return { outcome: "UNAVAILABLE", reason };
  }

  private record(outcome: "LIVE" | string, start: number): void {
    const errorCategory = outcome === "LIVE" ? "none" : outcome.toLowerCase();
    metrics.inc("place_provider_requests_total", {
      outcome: outcome === "LIVE" ? "live" : "unavailable",
      provider: "openrouteservice",
      error_category: errorCategory,
    });
    metrics.observe("place_provider_latency_ms", Date.now() - start, {
      provider: "openrouteservice",
      outcome: outcome === "LIVE" ? "live" : "unavailable",
    });
  }
}

const PLACE_RESULT_LIMIT = 10;

/**
 * The words to search for, or `null` when there are none worth searching and
 * the question is better answered by looking around the point instead.
 *
 * "restaurant", "hotel" and "station" appear in the names of the things they
 * describe, so bounded to a circle they find them. "attraction" does not —
 * nothing near Sensō-ji is called that, and unbounded it returned a hair
 * salon named "Mane Attraction" three time zones away. So a category with no
 * usable word falls through to the reverse lookup, which needs no words.
 */
function searchTextFor(keyword: string, category: NormalizedPlaceCandidate["kind"]): string | null {
  const stated = keyword.trim();
  // The executor used to pass the category name here as if it were the
  // traveller's words; anything that still does is treated as no keyword.
  if (stated.length > 0 && stated.toUpperCase() !== category) return stated;
  switch (category) {
    case "RESTAURANT": return "restaurant";
    case "HOTEL": return "hotel";
    case "TRANSPORT_HUB": return "station";
    default: return null;
  }
}

function categoryToLayer(category: NormalizedPlaceCandidate["kind"]): string {
  switch (category) {
    case "HOTEL":
    case "RESTAURANT":
    case "TRANSPORT_HUB":
    case "ATTRACTION":
      return "venue";
    case "OTHER":
      return "address";
    default:
      return "address";
  }
}

function normalizeFeature(
  feature: OrsGeocodingResponse["features"][number],
  category: NormalizedPlaceCandidate["kind"],
  capturedAt: string,
  countryCode: string,
): NormalizedPlaceCandidate | null {
  const props = feature.properties;
  const confidence = typeof props.confidence === "number" ? props.confidence : 0;
  const [longitude, latitude] = feature.geometry.coordinates;
  const displayName = props.name ?? `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
  const cityName = props.locality ?? props.region_a ?? null;
  return {
    candidateId: randomUUID(),
    displayName,
    kind: category,
    // The country comes from the request, which is authoritative: the search
    // is filtered server-side by `boundary.country`, and ORS rejects a code it
    // does not recognise rather than widening the search.
    //
    // It is deliberately not derived from the response. That field is alpha-3,
    // and cutting it to two characters is not a conversion — CHN would read as
    // CH (Switzerland), AUT as AU (Australia), PRT as PR (Puerto Rico). Every
    // candidate in those countries was then discarded for failing to match the
    // alpha-2 that was asked for.
    countryCode,
    cityName,
    longitude,
    latitude,
    confidence,
    // ORS reports this on reverse lookups and on searches biased by a point;
    // it is what lets a reply say "200 m away" instead of just naming a place.
    distanceKm: typeof props.distance === "number" ? props.distance : null,
    // Low-confidence, ambiguous or out-of-country candidates require user
    // confirmation before being adopted into a TripPlace.
    needsUserConfirmation: confidence < 0.5,
    source: "ORS Geocoding",
    capturedAt,
  };
}
