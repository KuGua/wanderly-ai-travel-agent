import type {
  NavigationProvider,
  NormalizedRouteEvidence,
  NormalizedRouteStep,
  ProviderResult,
  RouteCoordinate,
} from "./types.js";
import { metrics } from "../observability/metrics.js";
import { observeExternalProviderFetch } from "../observability/external-provider.js";
import {
  ORS_DIRECTIONS_PROFILE,
  orsDirectionsResponseSchema,
  type OrsDirectionsResponse,
} from "./ors-navigation-schemas.js";

export interface OrsNavigationProviderOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  refreshAfterHours?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function readOrsNavigationConfiguration(env: NodeJS.ProcessEnv = process.env): OrsNavigationProviderOptions | null {
  const apiKey = env.ORS_API_KEY?.trim();
  const baseUrl = (env.ORS_BASE_URL ?? "https://api.openrouteservice.org").trim();
  const timeoutMs = Number(env.ORS_DIRECTIONS_TIMEOUT_MS ?? 10_000);
  const refreshAfterHours = Number(env.ORS_DIRECTIONS_REFRESH_HOURS ?? 24);
  if (!apiKey) return null;
  if (timeoutMs < 100 || timeoutMs > 30_000 || !Number.isInteger(timeoutMs)) {
    throw new Error("ORS_DIRECTIONS_TIMEOUT_MS must be an integer from 100 to 30000");
  }
  if (refreshAfterHours < 1 || refreshAfterHours > 168 || !Number.isInteger(refreshAfterHours)) {
    throw new Error("ORS_DIRECTIONS_REFRESH_HOURS must be an integer from 1 to 168");
  }
  return { apiKey, baseUrl, timeoutMs, refreshAfterHours };
}

export class OrsNavigationProvider implements NavigationProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly refreshAfterHours: number;

  constructor(private readonly options: OrsNavigationProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.refreshAfterHours = options.refreshAfterHours ?? 24;
  }

  async searchRoute(params: {
    originPlaceId: string;
    destinationPlaceId: string;
    originCoordinate: RouteCoordinate;
    destinationCoordinate: RouteCoordinate;
    mode: "WALK" | "DRIVE" | "CYCLE";
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedRouteEvidence>> {
    const start = Date.now();
    const capturedAt = this.now().toISOString();
    try {
      const profile = ORS_DIRECTIONS_PROFILE[params.mode];
      // The `/geojson` variant is POST-only — a GET against it answers 405,
      // which is what every route request used to get. Its body is the
      // FeatureCollection `orsDirectionsResponseSchema` already expects, so
      // POST is the variant to keep.
      const response = await this.request(
        `/v2/directions/${profile}/geojson`,
        {
          coordinates: [
            [params.originCoordinate.longitude, params.originCoordinate.latitude],
            [params.destinationCoordinate.longitude, params.destinationCoordinate.latitude],
          ],
        },
        params.signal,
      );
      if (response.status === 429) return this.unavailable("RATE_LIMITED", start);
      if (response.status >= 500) return this.unavailable("UPSTREAM_FAILURE", start);
      if (!response.ok) return this.unavailable("UPSTREAM_FAILURE", start);
      let payload: OrsDirectionsResponse;
      try {
        const parsed = orsDirectionsResponseSchema.safeParse(await response.json());
        if (!parsed.success) return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
        payload = parsed.data;
      } catch {
        return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
      }
      const feature = payload.features[0];
      const summary = feature?.properties?.summary;
      const geometry = feature?.geometry;
      if (!summary || !geometry) {
        return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
      }
      const encodedGeometry = encodeGeometry(geometry);
      if (!encodedGeometry) {
        return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
      }
      const steps = collectSteps(feature.properties.segments ?? []);
      const refreshAfter = new Date(capturedAt);
      refreshAfter.setHours(refreshAfter.getHours() + this.refreshAfterHours);
      this.record("LIVE", start, params.mode);
      const data: NormalizedRouteEvidence = {
        originPlaceId: params.originPlaceId,
        destinationPlaceId: params.destinationPlaceId,
        mode: params.mode,
        distanceMeters: summary.distance,
        durationSeconds: summary.duration,
        steps,
        encodedGeometry,
        source: `ORS Directions (${ORS_ATTRIBUTION})`,
        capturedAt,
        refreshAfter: refreshAfter.toISOString(),
      };
      return {
        outcome: "LIVE",
        data,
        source: data.source,
        capturedAt: data.capturedAt,
      };
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return this.unavailable("UPSTREAM_TIMEOUT", start);
      return this.unavailable("UPSTREAM_FAILURE", start);
    }
  }

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // The key moves to a header with the switch to POST: ORS accepts
    // `api_key` only as a query parameter, and a credential does not belong
    // in a URL that proxies and access logs retain.
    return observeExternalProviderFetch(
      { provider: "openrouteservice", operation: "navigation.route", method: "POST" },
      () => this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: this.options.apiKey,
          "content-type": "application/json",
          accept: "application/geo+json",
        },
        body: JSON.stringify(body),
        signal: composed,
      }),
    );
  }

  private unavailable(
    reason: Extract<ProviderResult<NormalizedRouteEvidence>, { outcome: "UNAVAILABLE" }>["reason"],
    start: number,
  ): ProviderResult<NormalizedRouteEvidence> {
    this.record(reason, start);
    return { outcome: "UNAVAILABLE", reason };
  }

  private record(outcome: "LIVE" | string, start: number, mode?: "WALK" | "DRIVE" | "CYCLE"): void {
    const errorCategory = outcome === "LIVE" ? "none" : outcome.toLowerCase();
    const transportMode = mode ? mode.toLowerCase() : "any";
    metrics.inc("navigation_provider_requests_total", {
      outcome: outcome === "LIVE" ? "live" : "unavailable",
      provider: "openrouteservice",
      error_category: errorCategory,
      transport_mode: transportMode,
    });
    metrics.observe("navigation_provider_latency_ms", Date.now() - start, {
      provider: "openrouteservice",
      outcome: outcome === "LIVE" ? "live" : "unavailable",
    });
  }
}

function encodeGeometry(geometry: OrsDirectionsResponse["features"][number]["geometry"]): string | null {
  if (geometry.type === "encoded_polyline") {
    return geometry.coordinates;
  }
  if (geometry.type === "LineString") {
    return JSON.stringify(geometry.coordinates);
  }
  return null;
}

function collectSteps(segments: ReadonlyArray<{ steps?: Array<{ instruction?: string; distance: number; duration: number }> }>): NormalizedRouteStep[] {
  const out: NormalizedRouteStep[] = [];
  let index = 0;
  for (const segment of segments) {
    for (const step of segment.steps ?? []) {
      out.push({
        index,
        instruction: step.instruction ?? `Step ${index + 1}`,
        distanceMeters: step.distance,
        durationSeconds: step.duration,
      });
      index += 1;
    }
  }
  return out;
}

export const ORS_ATTRIBUTION = "© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors";
