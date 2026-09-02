import { createHash } from "node:crypto";

import { metrics } from "../observability/metrics.js";
import { observeExternalProviderFetch } from "../observability/external-provider.js";
import type { HotelProvider, HotelProviderItem, HotelSearchParams, ProviderResult } from "./types.js";
import { serpApiHotelResponseSchema } from "./serpapi-hotel-schemas.js";

export interface SerpApiHotelProviderOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  maxDistanceKm?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_BASE_URL = "https://serpapi.com/search.json";
const SOURCE = "SerpApi Google Hotels" as const;
type UnavailableReason = Extract<ProviderResult<never>, { outcome: "UNAVAILABLE" }>["reason"];

export function readSerpApiHotelConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): SerpApiHotelProviderOptions | null {
  if ((env.SERPAPI_HOTEL_ENABLED ?? "false").trim().toLowerCase() !== "true") return null;
  const apiKey = env.SERPAPI_HOTEL_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    timeoutMs: boundedInteger(env.SERPAPI_HOTEL_TIMEOUT_MS, 10_000, 500, 30_000, "SERPAPI_HOTEL_TIMEOUT_MS"),
    maxRetries: boundedInteger(env.SERPAPI_HOTEL_MAX_RETRIES, 1, 0, 2, "SERPAPI_HOTEL_MAX_RETRIES"),
    maxDistanceKm: boundedInteger(env.SERPAPI_HOTEL_MAX_DISTANCE_KM, 75, 1, 500, "SERPAPI_HOTEL_MAX_DISTANCE_KM"),
    ...(env.SERPAPI_HOTEL_BASE_URL?.trim() ? { baseUrl: env.SERPAPI_HOTEL_BASE_URL.trim() } : {}),
  };
}

export class SerpApiHotelProvider implements HotelProvider {
  readonly providerName = "serpapi_google_hotels" as const;
  readonly source = SOURCE;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: SerpApiHotelProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async searchHotels(params: HotelSearchParams): Promise<ProviderResult<HotelProviderItem[]>> {
    const startedAt = Date.now();
    let last: ProviderResult<HotelProviderItem[]> = { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      last = await this.attempt(params).catch((error: unknown) => ({
        outcome: "UNAVAILABLE" as const,
        reason: (error as { name?: string }).name === "AbortError"
          ? "UPSTREAM_TIMEOUT" as const
          : "UPSTREAM_FAILURE" as const,
      }));
      if (last.outcome === "LIVE" || !isRetryable(last.reason) || attempt === this.options.maxRetries) break;
    }
    return this.record(last, startedAt);
  }

  private async attempt(params: HotelSearchParams): Promise<ProviderResult<HotelProviderItem[]>> {
    const nights = daysBetween(params.checkIn, params.checkOut);
    const adults = params.adultsPerRoom.reduce((sum, count) => sum + count, 0);
    // Google Hotels search has no documented multi-room parameter. Never
    // present a one-room price as authoritative for a multi-room request.
    if (nights < 1 || adults < 1 || params.roomCount !== 1 || params.adultsPerRoom.length !== 1) {
      return { outcome: "UNAVAILABLE", reason: "SEARCH_CONSTRAINTS_INCOMPLETE" };
    }

    const url = new URL(this.options.baseUrl ?? DEFAULT_BASE_URL);
    url.searchParams.set("engine", "google_hotels");
    url.searchParams.set("q", `${params.destination.cityName}, ${params.destination.countryCode}`);
    url.searchParams.set("check_in_date", params.checkIn);
    url.searchParams.set("check_out_date", params.checkOut);
    url.searchParams.set("adults", String(adults));
    url.searchParams.set("currency", params.currency);
    url.searchParams.set("hl", params.locale);
    url.searchParams.set("api_key", this.options.apiKey);

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
    const response = await observeExternalProviderFetch(
      { provider: "serpapi", operation: "hotel.search", method: "GET" },
      () => this.fetchImpl(url, { headers: { accept: "application/json" }, signal }),
    );
    if (response.status === 401 || response.status === 403) return { outcome: "UNAVAILABLE", reason: "PROVIDER_NOT_APPROVED" };
    if (response.status === 429) return { outcome: "UNAVAILABLE", reason: "RATE_LIMITED" };
    if (response.status >= 500) return { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };
    if (!response.ok) return { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };

    const parsed = serpApiHotelResponseSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success) return { outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" };
    if (parsed.data.error) return { outcome: "UNAVAILABLE", reason: mapProviderError(parsed.data.error) };
    if (parsed.data.search_metadata.status !== "Success") return { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };

    const capturedAt = this.now().toISOString();
    const offers = (parsed.data.properties ?? []).flatMap((property) => {
      if (!property.gps_coordinates) return [];
      const distanceKm = haversineKm(
        params.destination.latitude,
        params.destination.longitude,
        property.gps_coordinates.latitude,
        property.gps_coordinates.longitude,
      );
      if (distanceKm > (this.options.maxDistanceKm ?? 75)) return [];
      const totalPrice = property.total_rate?.extracted_lowest
        ?? (property.rate_per_night ? property.rate_per_night.extracted_lowest * nights : undefined);
      const pricePerNight = property.rate_per_night?.extracted_lowest
        ?? (totalPrice === undefined ? undefined : totalPrice / nights);
      if (totalPrice === undefined || pricePerNight === undefined) return [];
      const beforeTaxes = property.total_rate?.extracted_before_taxes_fees;
      const taxAmount = beforeTaxes === undefined ? undefined : roundMoney(Math.max(0, totalPrice - beforeTaxes));
      const starClass = property.extracted_hotel_class
        ?? (typeof property.hotel_class === "number" ? property.hotel_class : undefined);
      return [{
        providerOfferId: digest(`${parsed.data.search_metadata.id}:${property.property_token}`),
        destinationId: params.destination.destinationId,
        propertyId: digest(property.property_token),
        propertyName: property.name,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        nights,
        roomCount: params.roomCount,
        adultsPerRoom: [...params.adultsPerRoom],
        totalPrice: roundMoney(totalPrice),
        pricePerNight: roundMoney(pricePerNight),
        currency: params.currency,
        taxesAndFees: taxAmount === undefined
          ? { status: "UNKNOWN" as const }
          : { status: "INCLUDED" as const, amount: taxAmount },
        cancellationSummary: property.free_cancellation === true ? "Free cancellation available" : null,
        roomSummary: [
          starClass ? `${starClass}-star` : null,
          property.amenities?.slice(0, 3).join(", ") || null,
        ].filter(Boolean).join(" · ") || null,
        capturedAt,
        expiresAt: new Date(Date.parse(capturedAt) + 15 * 60_000).toISOString(),
      } satisfies HotelProviderItem];
    }).slice(0, 10);
    if (offers.length === 0) return { outcome: "UNAVAILABLE", reason: "NO_RESULTS" };
    return { outcome: "LIVE", data: offers, source: SOURCE, capturedAt };
  }

  private record<T extends ProviderResult<HotelProviderItem[]>>(result: T, startedAt: number): T {
    const outcome = result.outcome === "LIVE" ? "live" : "unavailable";
    const errorCategory = result.outcome === "LIVE" ? "none" : result.reason.toLowerCase();
    metrics.inc("hotel_provider_requests_total", { outcome, provider: "serpapi_google_hotels", error_category: errorCategory });
    metrics.observe("hotel_provider_latency_ms", Date.now() - startedAt, { provider: "serpapi_google_hotels", outcome });
    return result;
  }
}

function mapProviderError(message: string): UnavailableReason {
  const lower = message.toLowerCase();
  if (lower.includes("credit") || lower.includes("rate limit")) return "RATE_LIMITED";
  if (lower.includes("api key") || lower.includes("account")) return "PROVIDER_NOT_APPROVED";
  return "UPSTREAM_FAILURE";
}

function isRetryable(reason: UnavailableReason): boolean {
  return reason === "UPSTREAM_FAILURE" || reason === "UPSTREAM_TIMEOUT";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("SerpApi response exceeded limit");
  return JSON.parse(text) as unknown;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function haversineKm(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(toLat - fromLat);
  const longitudeDelta = radians(toLon - fromLon);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
