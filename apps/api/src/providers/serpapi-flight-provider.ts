import { logProviderRejection } from "./provider-error-diagnostics.js";
import { randomUUID } from "node:crypto";
import type { FlightOffer } from "../types/domain.js";
import { metrics } from "../observability/metrics.js";
import { observeExternalProviderFetch } from "../observability/external-provider.js";
import type { FlightProvider, FlightSearchParams, ProviderResult } from "./types.js";
import { serpApiFlightSearchResponseSchema, serpApiItinerarySchema, type SerpApiFlightSearchResponse, type SerpApiItinerary } from "./serpapi-flight-schemas.js";
import { executeWithPolicy, getResiliencePolicyForSkill } from "../config/resilience-policy.js";

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
      // Resolved once and reused below: the itinerary-route check has to
      // compare against what was actually asked of the supplier, not the
      // original metro code — Google Flights' own response for `NRT` legs
      // never carries `TYO`, so comparing against the unresolved code threw
      // "route does not match" on every real offer and turned a working
      // search back into a false NO_RESULTS.
      const resolvedOrigin = resolveGoogleFlightsLocationId(params.origin);
      const resolvedDestination = resolveGoogleFlightsLocationId(params.destination);
      const response = await this.request(params, tripType, resolvedOrigin, resolvedDestination);
      if (response.status === 429) return this.unavailable("RATE_LIMITED", start);
      if (response.status === 401 || response.status === 403) return this.unavailable("PROVIDER_NOT_APPROVED", start);
      if (response.status >= 500) return this.unavailable("UPSTREAM_FAILURE", start);
      if (!response.ok) {
        // 4xx: the supplier understood the request and refused it, so this is
        // our parameters, not its health. Read its explanation before the
        // response is discarded — it is the only thing that names the field
        // it objected to.
        await logProviderRejection(response, { provider: "serpapi", operation: "flight.search" });
        return this.unavailable("PROVIDER_REQUEST_REJECTED", start);
      }

      const parsed = serpApiFlightSearchResponseSchema.safeParse(await response.json());
      if (!parsed.success) return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
      if (parsed.data.search_metadata.status.toLowerCase() !== "success") return this.unavailable("UPSTREAM_FAILURE", start);

      const queryId = randomUUID();
      const offers = [...parsed.data.best_flights, ...parsed.data.other_flights].flatMap((raw, index) => {
        // An itinerary that fails its own schema — most often one Google
        // Flights returned with no `price` — is skipped, not fatal.
        const itinerary = serpApiItinerarySchema.safeParse(raw);
        if (!itinerary.success) return [];
        try {
          return [normalizeOffer(parsed.data, itinerary.data, index, {
            queryId,
            capturedAt,
            origin: resolvedOrigin,
            destination: resolvedDestination,
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
      // P1-B: `executeWithPolicy` re-throws a transient-status error after
      // exhausting the retry budget; map it to the typed reason.
      const status = (error as { status?: number }).status;
      if (status === 429) return this.unavailable("RATE_LIMITED", start);
      if (typeof status === "number" && status >= 500) return this.unavailable("UPSTREAM_FAILURE", start);
      if ((error as { name?: string }).name === "AbortError") return this.unavailable("UPSTREAM_TIMEOUT", start);
      return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
    }
  }

  private async request(
    params: FlightSearchParams,
    tripType: "ONE_WAY" | "ROUND_TRIP",
    resolvedOrigin: string,
    resolvedDestination: string,
  ): Promise<Response> {
    const query = new URLSearchParams({
      engine: "google_flights",
      api_key: this.options.apiKey,
      departure_id: resolvedOrigin,
      arrival_id: resolvedDestination,
      outbound_date: params.dateStart,
      type: tripType === "ROUND_TRIP" ? "1" : "2",
      travel_class: String(mapCabin(params.cabin)),
      adults: String(params.adults ?? 1),
      currency: params.currency ?? "USD",
      gl: this.options.country,
      hl: this.options.language,
    });
    if (tripType === "ROUND_TRIP") query.set("return_date", params.dateEnd);
    const policy = getResiliencePolicyForSkill("flight.search");
    // P1-B: transient upstream failures (5xx, 429) now retry under the
    // unified resilience-policy loop. Per-attempt timeouts are owned by
    // the policy; the caller's signal is merged for lease-loss / cancel.
    return executeWithPolicy(policy, async (perAttemptSignal) => {
      const response = await observeExternalProviderFetch(
        { provider: "serpapi", operation: "flight.search", method: "GET" },
        () => this.fetchImpl(`${SERPAPI_SEARCH_URL}?${query}`, { method: "GET", signal: perAttemptSignal }),
      );
      if (response.status === 429 || response.status >= 500) {
        const err = new Error(`SerpApi transient ${response.status}`);
        (err as { status?: number }).status = response.status;
        throw err;
      }
      return response;
    }, params.signal);
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

/**
 * Google Flights' `departure_id`/`arrival_id` mostly reject the IATA
 * "metropolitan area" code for a multi-airport city — confirmed by calling
 * the supplier directly with `arrival_id=TYO`, `LON`, `NYC`, `PAR`, `BJS`:
 * each came back `search_metadata.status: "Success"` with zero flights and
 * "Google Flights hasn't returned any results for this query", which this
 * adapter cannot tell apart from a route that genuinely has none. The same
 * routes against a specific airport in that city returned real itineraries.
 * Rewriting the well-known ones to their primary airport turns a false
 * NO_RESULTS into a real answer; a traveller who wants a different airport
 * in the same city can still ask for it by its own code.
 */
const METRO_CODE_TO_PRIMARY_AIRPORT: Record<string, string> = {
  TYO: "NRT", OSA: "KIX", SEL: "ICN", BJS: "PEK",
  LON: "LHR", PAR: "CDG", NYC: "JFK", CHI: "ORD", WAS: "IAD",
  MOW: "SVO", ROM: "FCO", MIL: "MXP", STO: "ARN",
  BUE: "EZE", RIO: "GIG", SAO: "GRU",
};

function resolveGoogleFlightsLocationId(code: string): string {
  return METRO_CODE_TO_PRIMARY_AIRPORT[code.toUpperCase()] ?? code;
}

function mapCabin(cabin: FlightSearchParams["cabin"]): 1 | 2 | 3 | 4 {
  return ({ ECONOMY: 1, PREMIUM_ECONOMY: 2, BUSINESS: 3, FIRST: 4 } as const)[cabin ?? "ECONOMY"];
}

function normalizeOffer(
  payload: SerpApiFlightSearchResponse,
  itinerary: SerpApiItinerary,
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
    // Google Flights has no fare-hold/ticketing-deadline concept at all —
    // this is purely our own cache-freshness heuristic, never a supplier
    // guarantee (spec §6.2). Always SYNTHETIC; never PROVIDER_VERIFIED.
    expiresAt: new Date(Date.parse(params.capturedAt) + 15 * 60_000).toISOString(),
    expiryProvenance: "SYNTHETIC",
  };
}

function toIsoDuration(minutes: number): string {
  return `PT${Math.floor(minutes / 60)}H${minutes % 60}M`;
}
