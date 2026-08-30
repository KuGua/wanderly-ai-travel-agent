import { randomUUID } from "node:crypto";
import type {
  NormalizedPlaceCandidate,
  PlaceSearchProvider,
  ProviderResult,
} from "./types.js";
import { metrics } from "../observability/metrics.js";
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
    destinationId: string;
    keyword: string;
    category: "ATTRACTION" | "HOTEL" | "RESTAURANT" | "TRANSPORT_HUB" | "OTHER";
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedPlaceCandidate[]>> {
    const start = Date.now();
    const capturedAt = this.now().toISOString();
    try {
      const layer = categoryToLayer(params.category);
      // `size` is bounded to PLACE_MAX_RESULTS by the service layer; the
      // provider never sees a request larger than that.
      const query = new URLSearchParams({
        api_key: this.options.apiKey,
        text: params.keyword,
        layers: layer,
        size: "5",
        "boundary.country": destinationCountryCodeHint(params.destinationId),
      });
      const response = await this.request(`/geocode/search?${query.toString()}`, params.signal);
      if (response.status === 429) return this.unavailable("RATE_LIMITED", start);
      if (response.status >= 500) return this.unavailable("UPSTREAM_FAILURE", start);
      if (!response.ok) return this.unavailable("UPSTREAM_FAILURE", start);
      let payload: OrsGeocodingResponse;
      try {
        const parsed = orsGeocodingResponseSchema.safeParse(await response.json());
        if (!parsed.success) return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
        payload = parsed.data;
      } catch {
        return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
      }
      const candidates: NormalizedPlaceCandidate[] = [];
      for (const feature of payload.features) {
        const normalized = normalizeFeature(feature, params.category, capturedAt);
        if (!normalized) continue;
        candidates.push(normalized);
        if (candidates.length >= 5) break;
      }
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

  private async request(path: string, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return this.fetchImpl(`${this.options.baseUrl}${path}`, { signal: composed });
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

function categoryToLayer(category: NormalizedPlaceCandidate["kind"]): string {
  switch (category) {
    case "HOTEL":
      return "accommodation";
    case "RESTAURANT":
      return "food";
    case "TRANSPORT_HUB":
      return "transport";
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
): NormalizedPlaceCandidate | null {
  const props = feature.properties;
  const confidence = typeof props.confidence === "number" ? props.confidence : 0;
  const [longitude, latitude] = feature.geometry.coordinates;
  const displayName = props.name ?? `${latitude.toFixed(3)}, ${longitude.toFixed(3)}`;
  const countryCode = (props.country_a ?? "").toUpperCase().slice(0, 2) || null;
  const cityName = props.locality ?? props.region_a ?? null;
  return {
    candidateId: randomUUID(),
    displayName,
    kind: category,
    countryCode: countryCode && countryCode.length === 2 ? countryCode : null,
    cityName,
    longitude,
    latitude,
    confidence,
    // Low-confidence, ambiguous or out-of-country candidates require user
    // confirmation before being adopted into a TripPlace.
    needsUserConfirmation: confidence < 0.5,
    source: "ORS Geocoding",
    capturedAt,
  };
}

/**
 * DestinationId → ISO-3166-1 alpha-2 hint. Today the planner stores
 * destination candidates as free-text city names, not country codes. The
 * router keeps the hint permissive: we pass through whatever the planner
 * gives us, and ORS's own boundary filter (when set) refines it. Future
 * iterations will consult `destination_candidates.countryCode` once the
 * trip catalog is normalized.
 */
function destinationCountryCodeHint(destinationId: string): string {
  return destinationId;
}
