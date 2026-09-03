import { metrics } from "../observability/metrics.js";
import { observeExternalProviderFetch } from "../observability/external-provider.js";
import type {
  AccommodationDiscoveryProvider,
  AccommodationProviderItem,
  ProviderResult,
} from "./types.js";
import { openTripMapAccommodationResponseSchema } from "./opentripmap-accommodation-schemas.js";
import { executeWithPolicy, getResiliencePolicyForSkill } from "../config/resilience-policy.js";

const DEFAULT_BASE_URL = "https://api.opentripmap.com/0.1";
const SOURCE = "OpenTripMap" as const;
const ATTRIBUTION = "© OpenStreetMap contributors" as const;

export interface OpenTripMapAccommodationProviderOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  radiusMeters: number;
  maxResults: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function readOpenTripMapAccommodationConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): OpenTripMapAccommodationProviderOptions | null {
  if ((env.OPENTRIPMAP_ACCOMMODATION_ENABLED ?? "false").trim().toLowerCase() !== "true") return null;
  const apiKey = env.OPENTRIPMAP_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.OPENTRIPMAP_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/$/, "");
  if (new URL(baseUrl).protocol !== "https:") throw new Error("OPENTRIPMAP_BASE_URL must use HTTPS");
  return {
    apiKey,
    baseUrl,
    timeoutMs: boundedInteger(env.OPENTRIPMAP_TIMEOUT_MS, 8_000, 500, 30_000, "OPENTRIPMAP_TIMEOUT_MS"),
    radiusMeters: boundedInteger(env.OPENTRIPMAP_ACCOMMODATION_RADIUS_METERS, 10_000, 1_000, 50_000, "OPENTRIPMAP_ACCOMMODATION_RADIUS_METERS"),
    maxResults: boundedInteger(env.OPENTRIPMAP_ACCOMMODATION_MAX_RESULTS, 20, 1, 50, "OPENTRIPMAP_ACCOMMODATION_MAX_RESULTS"),
  };
}

export class OpenTripMapAccommodationProvider implements AccommodationDiscoveryProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: OpenTripMapAccommodationProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async discoverAccommodations(params: {
    destination: Parameters<AccommodationDiscoveryProvider["discoverAccommodations"]>[0]["destination"];
    limit: number;
    radiusMeters?: number;
    signal?: AbortSignal;
  }): Promise<ProviderResult<AccommodationProviderItem[]>> {
    const startedAt = Date.now();
    if (!Number.isInteger(params.limit) || params.limit < 1) {
      return this.record({ outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE" }, startedAt);
    }
    // The caller's radius when it has one; the configured default otherwise.
    // Bounded by the same limits the configuration is bounded by, so a caller
    // cannot widen the search past what the deployment allows.
    const radiusMeters = params.radiusMeters === undefined
      ? this.options.radiusMeters
      : Math.min(Math.max(Math.round(params.radiusMeters), 1_000), 50_000);
    try {
      const url = new URL(`${this.options.baseUrl}/en/places/radius`);
      url.searchParams.set("radius", String(radiusMeters));
      url.searchParams.set("lon", String(params.destination.longitude));
      url.searchParams.set("lat", String(params.destination.latitude));
      // OpenTripMap's public taxonomy intentionally spells this collection
      // `accomodations`; changing it to the English spelling returns no data.
      url.searchParams.set("kinds", "accomodations");
      url.searchParams.set("limit", String(Math.min(params.limit, this.options.maxResults)));
      url.searchParams.set("format", "json");
      url.searchParams.set("apikey", this.options.apiKey);

      const policy = getResiliencePolicyForSkill("accommodation.discover");
      // P1-B: transient upstream failures (5xx, 429) now retry under the
      // unified resilience-policy loop.
      const response = await executeWithPolicy(policy, async (perAttemptSignal) => {
        const r = await observeExternalProviderFetch(
          { provider: "opentripmap", operation: "accommodation.discover", method: "GET" },
          () => this.fetchImpl(url, { headers: { accept: "application/json" }, signal: perAttemptSignal }),
        );
        if (r.status === 429 || r.status >= 500) {
          const err = new Error(`OpenTripMap transient ${r.status}`);
          (err as { status?: number }).status = r.status;
          throw err;
        }
        return r;
      }, params.signal);
      if (response.status === 401 || response.status === 403) return this.record({ outcome: "UNAVAILABLE", reason: "PROVIDER_NOT_APPROVED" }, startedAt);
      if (response.status === 429) return this.record({ outcome: "UNAVAILABLE", reason: "RATE_LIMITED" }, startedAt);
      if (response.status >= 500) return this.record({ outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" }, startedAt);
      if (!response.ok) return this.record({ outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" }, startedAt);

      const parsed = openTripMapAccommodationResponseSchema.safeParse(await readBoundedJson(response));
      if (!parsed.success) return this.record({ outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" }, startedAt);
      const capturedAt = this.now().toISOString();
      const data = parsed.data.flatMap((place): AccommodationProviderItem[] => {
        const name = place.name.trim();
        if (!name) return [];
        const distanceMeters = place.dist ?? haversineMeters(
          params.destination.latitude,
          params.destination.longitude,
          place.point.lat,
          place.point.lon,
        );
        if (distanceMeters > radiusMeters) return [];
        return [{
          providerPlaceId: place.xid,
          name,
          kind: primaryAccommodationKind(place.kinds),
          longitude: place.point.lon,
          latitude: place.point.lat,
          distanceMeters: Math.round(distanceMeters),
          popularityTier: place.rate && place.rate > 0 ? place.rate : null,
          source: SOURCE,
          attribution: ATTRIBUTION,
          capturedAt,
        }];
      }).slice(0, Math.min(params.limit, this.options.maxResults));
      if (data.length === 0) return this.record({ outcome: "UNAVAILABLE", reason: "NO_RESULTS" }, startedAt);
      return this.record({ outcome: "LIVE", data, source: SOURCE, capturedAt }, startedAt);
    } catch (error) {
      // P1-B: `executeWithPolicy` re-throws a transient-status error after
      // exhausting the retry budget; map it to the typed reason.
      const status = (error as { status?: number }).status;
      let reason: "UPSTREAM_TIMEOUT" | "UPSTREAM_FAILURE" | "RATE_LIMITED";
      if (status === 429) reason = "RATE_LIMITED";
      else if (typeof status === "number" && status >= 500) reason = "UPSTREAM_FAILURE";
      else if ((error as { name?: string }).name === "AbortError") reason = "UPSTREAM_TIMEOUT";
      else reason = "UPSTREAM_FAILURE";
      return this.record({ outcome: "UNAVAILABLE", reason }, startedAt);
    }
  }

  private record<T extends ProviderResult<AccommodationProviderItem[]>>(result: T, startedAt: number): T {
    const outcome = result.outcome === "LIVE" ? "live" : "unavailable";
    metrics.inc("accommodation_provider_requests_total", {
      outcome,
      provider: "opentripmap",
      error_category: result.outcome === "LIVE" ? "none" : result.reason.toLowerCase(),
    });
    metrics.observe("accommodation_provider_latency_ms", Date.now() - startedAt, {
      provider: "opentripmap",
      outcome,
    });
    return result;
  }
}

function primaryAccommodationKind(kinds: string): string {
  const values = kinds.split(",").map((value) => value.trim()).filter(Boolean);
  return values.find((value) => value !== "accomodations") ?? "accommodation";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("OpenTripMap response exceeded limit");
  return JSON.parse(text) as unknown;
}

function haversineMeters(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(toLat - fromLat);
  const longitudeDelta = radians(toLon - fromLon);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
