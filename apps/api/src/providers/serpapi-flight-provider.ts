import { randomUUID } from "node:crypto";
import type { FlightOffer } from "../types/domain.js";
import { metrics } from "../observability/metrics.js";
import type { FlightProvider, FlightSearchParams, ProviderResult } from "./types.js";
import { serpApiFlightSearchResponseSchema, type SerpApiFlightSearchResponse } from "./serpapi-flight-schemas.js";

export interface SerpApiFlightProviderOptions {
  apiKey: string;
  timeoutMs: number;
  country: string;
  language: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const SERPAPI_SEARCH_URL = "https://serpapi.com/search.json";
const SOURCE = "SerpAPI Google Flights";

export function readSerpApiConfiguration(env: NodeJS.ProcessEnv = process.env): SerpApiFlightProviderOptions {
  const apiKey = env.SERPAPI_API_KEY?.trim();
  const timeoutMs = Number(env.SERPAPI_FLIGHT_TIMEOUT_MS ?? 15_000);
  const country = (env.SERPAPI_GOOGLE_FLIGHTS_GL ?? "us").trim().toLowerCase();
  const language = (env.SERPAPI_GOOGLE_FLIGHTS_HL ?? "en").trim().toLowerCase();
  if (!apiKey) throw new Error("FLIGHT_PROVIDER=serpapi requires SERPAPI_API_KEY");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("SERPAPI_FLIGHT_TIMEOUT_MS must be an integer from 100 to 30000");
  }
  if (!/^[a-z]{2}$/.test(country)) throw new Error("SERPAPI_GOOGLE_FLIGHTS_GL must be a two-letter country code");
  if (!/^[a-z]{2}$/.test(language)) throw new Error("SERPAPI_GOOGLE_FLIGHTS_HL must be a two-letter language code");
  return { apiKey, timeoutMs, country, language };
}

/**
 * The supplier requires its key in a query parameter. URL construction stays
 * entirely inside this adapter; callers receive normalized offers or a bounded
 * UNAVAILABLE reason only, never a supplier URL, key, raw payload, or error.
 */
export class SerpApiFlightProvider implements FlightProvider {
  readonly providerName = "serpapi" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: SerpApiFlightProviderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async searchFlights(params: FlightSearchParams): Promise<ProviderResult<FlightOffer[]>> {
    const start = Date.now();
    const capturedAt = this.now().toISOString();
    try {
      const tripType = params.tripType ?? "ROUND_TRIP";
      if (tripType === "ROUND_TRIP" && !params.dateEnd) return this.unavailable("SEARCH_CONSTRAINTS_INCOMPLETE", start);
      const response = await this.request(params, tripType);
      if (response.status === 429) return this.unavailable("RATE_LIMITED", start);
      if (response.status === 401 || response.status === 403) return this.unavailable("PROVIDER_NOT_APPROVED", start);
      if (response.status >= 500) return this.unavailable("UPSTREAM_FAILURE", start);
      if (!response.ok) return this.unavailable("UPSTREAM_FAILURE", start);

      const parsed = serpApiFlightSearchResponseSchema.safeParse(await response.json());
      if (!parsed.success) return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
      if (parsed.data.search_metadata.status.toLowerCase() !== "success") return this.unavailable("UPSTREAM_FAILURE", start);

      const queryId = randomUUID();
      const offers = [...parsed.data.best_flights, ...parsed.data.other_flights].flatMap((itinerary, index) => {
        try {
          return [normalizeOffer(parsed.data, itinerary, index, {
            queryId,
            capturedAt,
            origin: params.origin,
            destination: params.destination,
            adults: params.adults ?? 1,
            cabin: params.cabin ?? "ECONOMY",
            currency: params.currency ?? "USD",
          })];
        } catch {
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

  private async request(params: FlightSearchParams, tripType: "ONE_WAY" | "ROUND_TRIP"): Promise<Response> {
    const query = new URLSearchParams({
      engine: "google_flights",
      api_key: this.options.apiKey,
      departure_id: params.origin,
      arrival_id: params.destination,
      outbound_date: params.dateStart,
      type: tripType === "ROUND_TRIP" ? "1" : "2",
      travel_class: String(mapCabin(params.cabin)),
      adults: String(params.adults ?? 1),
      currency: params.currency ?? "USD",
      gl: this.options.country,
      hl: this.options.language,
    });
    if (tripType === "ROUND_TRIP") query.set("return_date", params.dateEnd);
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
    return this.fetchImpl(`${SERPAPI_SEARCH_URL}?${query}`, { method: "GET", signal });
  }

  private unavailable(reason: Extract<ProviderResult<FlightOffer[]>, { outcome: "UNAVAILABLE" }>["reason"], start: number): ProviderResult<FlightOffer[]> {
    this.record(reason, start);
    return { outcome: "UNAVAILABLE", reason };
  }

  private record(outcome: "LIVE" | string, start: number): void {
    const errorCategory = outcome === "LIVE" ? "none" : outcome.toLowerCase();
    metrics.inc("flight_provider_requests_total", { outcome: outcome === "LIVE" ? "live" : "unavailable", provider: "serpapi", error_category: errorCategory });
    metrics.observe("flight_provider_latency_ms", Date.now() - start, { provider: "serpapi", outcome: outcome === "LIVE" ? "live" : "unavailable" });
  }
}

function mapCabin(cabin: FlightSearchParams["cabin"]): 1 | 2 | 3 | 4 {
  return ({ ECONOMY: 1, PREMIUM_ECONOMY: 2, BUSINESS: 3, FIRST: 4 } as const)[cabin ?? "ECONOMY"];
}

function normalizeOffer(
  payload: SerpApiFlightSearchResponse,
  itinerary: SerpApiFlightSearchResponse["best_flights"][number],
  index: number,
  params: { queryId: string; capturedAt: string; origin: string; destination: string; adults: number; cabin: NonNullable<FlightSearchParams["cabin"]>; currency: string },
): FlightOffer {
  const first = itinerary.flights[0]!;
  const last = itinerary.flights.at(-1)!;
  if (first.departure_airport.id !== params.origin || last.arrival_airport.id !== params.destination) {
    throw new Error("SerpAPI result route does not match the controlled request");
  }
  const segments = itinerary.flights.map((flight) => {
    const match = /^([A-Z0-9]{2})\s*([A-Z0-9-]{1,8})$/i.exec(flight.flight_number.trim());
    if (!match) throw new Error("SerpAPI flight number cannot be normalized safely");
    return {
      carrierCode: match[1]!.toUpperCase(),
      flightNumber: match[2]!.toUpperCase(),
      origin: flight.departure_airport.id,
      destination: flight.arrival_airport.id,
      departureAt: flight.departure_airport.time,
      arrivalAt: flight.arrival_airport.time,
      duration: toIsoDuration(flight.duration),
    };
  });
  const baggageNotes = itinerary.flights.flatMap((flight) => flight.extensions ?? []).filter((note) => /bag|baggage|carry-on/i.test(note));
  return {
    id: `serpapi:${payload.search_metadata.id}:${index}`,
    providerOfferId: `${payload.search_metadata.id}:${index}`,
    providerName: "serpapi",
    queryId: params.queryId,
    origin: first.departure_airport.id,
    destination: last.arrival_airport.id,
    segments,
    totalDuration: toIsoDuration(itinerary.total_duration),
    totalPrice: itinerary.price,
    currency: params.currency,
    cabin: params.cabin,
    adults: params.adults,
    baggageSummary: baggageNotes.length > 0 ? baggageNotes.join("; ") : null,
    changeSummary: segments.length > 1 ? `${segments.length - 1} stop${segments.length === 2 ? "" : "s"}` : "Nonstop",
    source: SOURCE,
    capturedAt: params.capturedAt,
    expiresAt: new Date(Date.parse(params.capturedAt) + 15 * 60_000).toISOString(),
  };
}

function toIsoDuration(minutes: number): string {
  return `PT${Math.floor(minutes / 60)}H${minutes % 60}M`;
}
