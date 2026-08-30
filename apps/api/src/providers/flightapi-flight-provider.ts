import { randomUUID } from "node:crypto";
import type { FlightOffer } from "../types/domain.js";
import { metrics } from "../observability/metrics.js";
import type { FlightProvider, FlightSearchParams, ProviderResult } from "./types.js";
import { flightApiFlightSearchResponseSchema, type FlightApiFlightSearchResponse } from "./flightapi-flight-schemas.js";

export interface FlightApiProviderOptions {
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

const FLIGHT_API_BASE_URL = "https://api.flightapi.io";
const SOURCE = "FlightAPI Flight Price API";

export function readFlightApiConfiguration(env: NodeJS.ProcessEnv = process.env): FlightApiProviderOptions {
  const apiKey = env.FLIGHTAPI_API_KEY?.trim();
  const timeoutMs = Number(env.FLIGHTAPI_FLIGHT_TIMEOUT_MS ?? 15_000);
  if (!apiKey) throw new Error("FLIGHT_PROVIDER=flightapi requires FLIGHTAPI_API_KEY");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("FLIGHTAPI_FLIGHT_TIMEOUT_MS must be an integer from 100 to 30000");
  }
  return { apiKey, timeoutMs };
}

/**
 * FlightAPI's key is part of its path contract. The constructed URL must stay
 * inside this adapter: it is never logged, persisted, attached to errors, or
 * returned from this provider.
 */
export class FlightApiProvider implements FlightProvider {
  readonly providerName = "flightapi" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: FlightApiProviderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async searchFlights(params: FlightSearchParams): Promise<ProviderResult<FlightOffer[]>> {
    const start = Date.now();
    const capturedAt = this.now().toISOString();
    try {
      const tripType = params.tripType ?? "ROUND_TRIP";
      if (tripType === "ROUND_TRIP" && !params.dateEnd) return this.unavailable("SEARCH_CONSTRAINTS_INCOMPLETE", start);
      const cabin = mapCabin(params.cabin);
      const path = tripType === "ROUND_TRIP"
        ? ["roundtrip", this.options.apiKey, params.origin, params.destination, params.dateStart, params.dateEnd, String(params.adults ?? 1), "0", "0", cabin, params.currency ?? "USD"]
        : ["onewaytrip", this.options.apiKey, params.origin, params.destination, params.dateStart, String(params.adults ?? 1), "0", "0", cabin, params.currency ?? "USD"];
      const response = await this.request(path, params.signal);
      if (response.status === 429) return this.unavailable("RATE_LIMITED", start);
      if (response.status === 401 || response.status === 403) return this.unavailable("PROVIDER_NOT_APPROVED", start);
      if (response.status >= 500) return this.unavailable("UPSTREAM_FAILURE", start);
      if (!response.ok) return this.unavailable("UPSTREAM_FAILURE", start);
      const parsed = flightApiFlightSearchResponseSchema.safeParse(await response.json());
      if (!parsed.success) return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
      if (parsed.data.itineraries.length === 0) return this.unavailable("NO_RESULTS", start);
      const queryId = randomUUID();
      const offers = parsed.data.itineraries.flatMap((itinerary) => {
        try {
          return [normalizeOffer(parsed.data, itinerary, {
            queryId, capturedAt, adults: params.adults ?? 1, cabin: params.cabin ?? "ECONOMY", currency: params.currency ?? "USD",
          })];
        } catch {
          // A provider can mix a valid itinerary with an unpriced or
          // internally inconsistent one. It is never exposed as an offer.
          return [];
        }
      });
      if (offers.length === 0) return this.unavailable("NO_RESULTS", start);
      this.record("LIVE", start);
      return { outcome: "LIVE", data: offers, source: SOURCE, capturedAt };
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return this.unavailable("UPSTREAM_TIMEOUT", start);
      return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
    }
  }

  private async request(pathParts: Array<string | undefined>, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const encodedPath = pathParts.map((part) => encodeURIComponent(part ?? "")).join("/");
    return this.fetchImpl(`${FLIGHT_API_BASE_URL}/${encodedPath}`, { method: "GET", signal: combinedSignal });
  }

  private unavailable(reason: Extract<ProviderResult<FlightOffer[]>, { outcome: "UNAVAILABLE" }>["reason"], start: number): ProviderResult<FlightOffer[]> {
    this.record(reason, start);
    return { outcome: "UNAVAILABLE", reason };
  }

  private record(outcome: "LIVE" | string, start: number): void {
    const errorCategory = outcome === "LIVE" ? "none" : outcome.toLowerCase();
    metrics.inc("flight_provider_requests_total", { outcome: outcome === "LIVE" ? "live" : "unavailable", provider: "flightapi", error_category: errorCategory });
    metrics.observe("flight_provider_latency_ms", Date.now() - start, { provider: "flightapi", outcome: outcome === "LIVE" ? "live" : "unavailable" });
  }
}

function mapCabin(cabin: FlightSearchParams["cabin"]): "Economy" | "Premium_Economy" | "Business" | "First" {
  return ({ ECONOMY: "Economy", PREMIUM_ECONOMY: "Premium_Economy", BUSINESS: "Business", FIRST: "First" } as const)[cabin ?? "ECONOMY"];
}

function normalizeOffer(
  payload: FlightApiFlightSearchResponse,
  itinerary: FlightApiFlightSearchResponse["itineraries"][number],
  params: { queryId: string; capturedAt: string; adults: number; cabin: NonNullable<FlightSearchParams["cabin"]>; currency: string },
): FlightOffer {
  const firstLeg = byId(payload.legs, itinerary.leg_ids[0]!);
  if (!firstLeg) throw new Error("FlightAPI itinerary references a missing outbound leg");
  const segments = firstLeg.segment_ids.map((id) => {
    const segment = byId(payload.segments, id);
    if (!segment) throw new Error("FlightAPI leg references a missing segment");
    return {
      carrierCode: String(segment.marketing_carrier_id),
      flightNumber: String(segment.marketing_flight_number),
      origin: placeIata(payload, segment.origin_place_id),
      destination: placeIata(payload, segment.destination_place_id),
      departureAt: segment.departure,
      arrivalAt: segment.arrival,
      duration: toIsoDuration(segment.duration),
    };
  });
  const totalPrice = itinerary.cheapest_price?.amount
    ?? itinerary.pricing_options?.find((option) => option.price?.amount !== undefined)?.price?.amount;
  if (totalPrice === undefined) throw new Error("FlightAPI itinerary has no usable price");
  return {
    id: `flightapi:${itinerary.id}`,
    providerOfferId: itinerary.id,
    providerName: "flightapi",
    queryId: params.queryId,
    origin: placeIata(payload, firstLeg.origin_place_id),
    destination: placeIata(payload, firstLeg.destination_place_id),
    segments,
    totalDuration: toIsoDuration(firstLeg.duration),
    totalPrice,
    currency: params.currency,
    cabin: params.cabin,
    adults: params.adults,
    baggageSummary: null,
    changeSummary: null,
    source: SOURCE,
    capturedAt: params.capturedAt,
    expiresAt: new Date(Date.parse(params.capturedAt) + 15 * 60_000).toISOString(),
  };
}

function byId<T extends { id: string }>(values: T[], id: string): T | undefined {
  return values.find((value) => value.id === id);
}

function placeIata(payload: FlightApiFlightSearchResponse, id: string | number): string {
  const place = payload.places.find((candidate) => String(candidate.id) === String(id));
  if (!place) throw new Error("FlightAPI segment references a place without an IATA code");
  return place.iata_code;
}

function toIsoDuration(minutes: number): string {
  return `PT${minutes}M`;
}
