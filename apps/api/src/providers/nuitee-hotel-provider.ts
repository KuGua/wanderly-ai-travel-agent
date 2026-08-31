import { createHash } from "node:crypto";

import { metrics } from "../observability/metrics.js";
import type {
  HotelProvider,
  HotelProviderItem,
  HotelSearchParams,
  ProviderResult,
} from "./types.js";
import { nuiteeHotelRatesResponseSchema } from "./nuitee-hotel-schemas.js";

/**
 * Spec: docs/nuitee-serpapi-hotel-provider-switching-implementation.md §4.2
 *
 * Adapter contract summary:
 *   - POST https://api.liteapi.travel/v3.0/hotels/rates with header
 *     `X-API-Key: <NUITEE_API_KEY>`.
 *   - Body: { checkin, checkout, currency, guestNationality, occupancies[],
 *             city, countryCode, maxRatesPerHotel: 1, includeHotelData: true }.
 *   - 12 s deadline, at most 1 retry on transient network / 5xx.
 *   - HTTP 200 + body.error.code === "2001" → `NO_RESULTS`
 *     (fail closed; never synthesize an empty success).
 *   - `quoteNationality` is required and MUST be supplied by the service
 *     layer (decrypted server-side from a `stay_search_provider_authorizations`
 *     row). The adapter refuses to issue the request without it.
 *   - Multi-room supported via the `occupancies` array (1..8 rooms, each
 *     1..8 adults). Out-of-range values short-circuit to
 *     `SEARCH_CONSTRAINTS_INCOMPLETE`.
 *   - The raw `rateId`, `hotelId`, request URL, full address, and image
 *     URLs NEVER cross the adapter boundary into persisted evidence,
 *     plan output, log/trace/audit, or metric labels.
 */
export interface NuiteeHotelProviderOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_BASE_URL = "https://api.liteapi.travel";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RETRIES = 1;
const SOURCE = "Nuitee LiteAPI Rates" as const;
const NUITEE_NO_RESULTS_CODE = "2001";
const MIN_ADULTS_PER_ROOM = 1;
const MAX_ADULTS_PER_ROOM = 8;
const MIN_ROOMS = 1;
const MAX_ROOMS = 8;
const MAX_RESULTS_RETURNED = 10;
const MAX_RESPONSE_BYTES = 2_000_000;

type UnavailableReason = Extract<ProviderResult<never>, { outcome: "UNAVAILABLE" }>["reason"];

export function readNuiteeHotelConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): NuiteeHotelProviderOptions | null {
  const apiKey = env.NUITEE_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    timeoutMs: boundedInteger(env.NUITEE_HOTEL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 500, 30_000, "NUITEE_HOTEL_TIMEOUT_MS"),
    maxRetries: boundedInteger(env.NUITEE_HOTEL_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 2, "NUITEE_HOTEL_MAX_RETRIES"),
    ...(env.NUITEE_BASE_URL?.trim() ? { baseUrl: env.NUITEE_BASE_URL.trim() } : {}),
  };
}

export class NuiteeHotelProvider implements HotelProvider {
  readonly providerName = "nuitee_connect" as const;
  readonly source = SOURCE;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: NuiteeHotelProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async searchHotels(params: HotelSearchParams): Promise<ProviderResult<HotelProviderItem[]>> {
    const startedAt = Date.now();
    const validationFailure = this.validateRequestShape(params);
    if (validationFailure) return this.record({ outcome: "UNAVAILABLE", reason: validationFailure }, startedAt);

    let last: ProviderResult<HotelProviderItem[]> = { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      last = await this.attempt(params).catch((error: unknown) => ({
        outcome: "UNAVAILABLE" as const,
        reason: (error as { name?: string }).name === "AbortError"
          ? ("UPSTREAM_TIMEOUT" as const)
          : ("UPSTREAM_FAILURE" as const),
      }));
      if (last.outcome === "LIVE" || !isRetryable(last.reason) || attempt === this.options.maxRetries) break;
    }
    return this.record(last, startedAt);
  }

  private validateRequestShape(params: HotelSearchParams): UnavailableReason | null {
    if (!params.quoteNationality) return "SEARCH_CONSTRAINTS_INCOMPLETE";
    if (params.roomCount < MIN_ROOMS || params.roomCount > MAX_ROOMS) return "SEARCH_CONSTRAINTS_INCOMPLETE";
    if (params.adultsPerRoom.length !== params.roomCount) return "SEARCH_CONSTRAINTS_INCOMPLETE";
    if (params.adultsPerRoom.some((n) => n < MIN_ADULTS_PER_ROOM || n > MAX_ADULTS_PER_ROOM)) {
      return "SEARCH_CONSTRAINTS_INCOMPLETE";
    }
    return null;
  }

  private async attempt(params: HotelSearchParams): Promise<ProviderResult<HotelProviderItem[]>> {
    const url = `${this.options.baseUrl ?? DEFAULT_BASE_URL}/v3.0/hotels/rates`;
    const body = JSON.stringify({
      checkin: params.checkIn,
      checkout: params.checkOut,
      currency: params.currency,
      guestNationality: params.quoteNationality,
      occupancies: params.adultsPerRoom.map((adults) => ({ adults })),
      city: params.destination.cityName,
      countryCode: params.destination.countryCode,
      maxRatesPerHotel: 1,
      includeHotelData: true,
    });

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
    // NOTE: deliberately never logs the URL, body, or API key. The fetch
    // call's `signal` is the only side-channel a debug build could observe.
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": this.options.apiKey,
      },
      body,
      signal,
    });
    if (response.status === 401 || response.status === 403) return { outcome: "UNAVAILABLE", reason: "PROVIDER_NOT_APPROVED" };
    if (response.status === 429) return { outcome: "UNAVAILABLE", reason: "RATE_LIMITED" };
    if (response.status >= 500) return { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };
    if (!response.ok) return { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };

    const json = await readBoundedJson(response);
    const parsed = nuiteeHotelRatesResponseSchema.safeParse(json);
    if (!parsed.success) return { outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" };
    if (parsed.data.error) {
      if (String(parsed.data.error.code) === NUITEE_NO_RESULTS_CODE) {
        return { outcome: "UNAVAILABLE", reason: "NO_RESULTS" };
      }
      return { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };
    }
    const hotels = parsed.data.data ?? [];
    if (hotels.length === 0) return { outcome: "UNAVAILABLE", reason: "NO_RESULTS" };

    const capturedAt = this.now().toISOString();
    const nights = daysBetween(params.checkIn, params.checkOut);
    const offers: HotelProviderItem[] = [];
    for (const hotel of hotels) {
      if (hotel.rates.length === 0) continue;
      // `maxRatesPerHotel: 1` is requested, but the response can still
      // contain more than one rate if the upstream contract drifts; the
      // adapter picks the first valid one to keep the result deterministic.
      const rate = hotel.rates[0];
      const retail = rate.retailRate;
      const totalAmount = roundMoney(retail.totalAmount);
      const pricePerNight = nights > 0 ? roundMoney(totalAmount / nights) : totalAmount;
      const taxFeeStatus = classifyTaxFeeStatus(retail.taxesAndFeesIncluded, retail.taxesAndFeesAmount);
      const roomSummary = composeRoomSummary(rate, hotel);
      const cancellationSummary = composeCancellationSummary(rate);
      offers.push({
        providerOfferId: stableOfferId({
          providerName: this.providerName,
          hotelId: hotel.hotelId,
          rateId: rate.rateId,
          checkIn: params.checkIn,
          nights,
          adultsPerRoom: params.adultsPerRoom,
          currency: params.currency,
        }),
        destinationId: params.destination.destinationId,
        propertyId: digest(hotel.hotelId),
        propertyName: hotel.name,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        nights,
        roomCount: params.roomCount,
        adultsPerRoom: [...params.adultsPerRoom],
        totalPrice: totalAmount,
        pricePerNight,
        currency: retail.currency,
        taxesAndFees: taxFeeStatus,
        cancellationSummary,
        roomSummary,
        capturedAt,
        // Nuitee rate TTL is bound to the supplier's quote, but the public
        // contract requires `expiresAt`. Use a conservative 15-minute window
        // (matching SerpApi and the HOTEL_LIVE_CACHE_TTL_MS) until the
        // supplier publishes a per-rate expiry.
        expiresAt: new Date(Date.parse(capturedAt) + 15 * 60_000).toISOString(),
      });
      if (offers.length >= MAX_RESULTS_RETURNED) break;
    }
    if (offers.length === 0) return { outcome: "UNAVAILABLE", reason: "NO_RESULTS" };
    return { outcome: "LIVE", data: offers, source: SOURCE, capturedAt };
  }

  private record<T extends ProviderResult<HotelProviderItem[]>>(result: T, startedAt: number): T {
    const outcome = result.outcome === "LIVE" ? "live" : "unavailable";
    const errorCategory = result.outcome === "LIVE" ? "none" : result.reason.toLowerCase();
    metrics.inc("hotel_provider_requests_total", { outcome, provider: this.providerName, error_category: errorCategory });
    metrics.observe("hotel_provider_latency_ms", Date.now() - startedAt, { provider: this.providerName, outcome });
    return result;
  }
}

function classifyTaxFeeStatus(
  included: boolean | undefined,
  amount: number | undefined,
): { status: "INCLUDED"; amount: number } | { status: "PARTIAL"; amount?: number } | { status: "UNKNOWN" } {
  // Strict classification per spec §4.2:
  //   INCLUDED only when the upstream marks the amount included and the
  //              numeric field is present and bounded.
  //   PARTIAL   when the upstream exposes a taxesAndFeesAmount but does
  //              not explicitly mark it complete (e.g. mandatory fees
  //              that the supplier cannot enumerate).
  //   UNKNOWN   otherwise.
  if (included === true && typeof amount === "number") {
    return { status: "INCLUDED", amount: roundMoney(amount) };
  }
  if (typeof amount === "number") {
    return { status: "PARTIAL", amount: roundMoney(amount) };
  }
  return { status: "UNKNOWN" };
}

function composeRoomSummary(
  rate: { roomTypes?: Array<{ description?: string | null; adults?: number }> },
  hotel: { starRating?: number | null },
): string | null {
  const parts: string[] = [];
  if (typeof hotel.starRating === "number" && hotel.starRating > 0) parts.push(`${hotel.starRating}-star`);
  const firstRoom = rate.roomTypes?.[0];
  if (firstRoom?.description) parts.push(firstRoom.description);
  if (firstRoom?.adults && firstRoom.adults > 0) parts.push(`${firstRoom.adults} adults`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function composeCancellationSummary(
  rate: { cancellationPolicies?: { cancellationPolicy?: Array<{ description?: string | null; type?: string }> | null } },
): string | null {
  const policies = rate.cancellationPolicies?.cancellationPolicy ?? [];
  const first = policies[0];
  if (!first) return null;
  if (first.description) return first.description;
  if (first.type) return `Cancellation: ${first.type}`;
  return null;
}

function stableOfferId(input: {
  providerName: string;
  hotelId: string;
  rateId: string;
  checkIn: string;
  nights: number;
  adultsPerRoom: number[];
  currency: string;
}): string {
  // Server-derived hash so the persisted offer key is stable across runs
  // but does not leak the raw rateId. Two distinct rateIds for the same
  // hotel/date/occupancy will produce different hashes; the supplier never
  // appears in logs.
  return digest(JSON.stringify(input));
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

function isRetryable(reason: UnavailableReason): boolean {
  return reason === "UPSTREAM_FAILURE" || reason === "UPSTREAM_TIMEOUT";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("Nuitee response exceeded limit");
  return JSON.parse(text) as unknown;
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
