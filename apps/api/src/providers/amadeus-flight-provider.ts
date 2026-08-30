import { randomUUID } from "node:crypto";
import type { FlightOffer } from "../types/domain.js";
import { metrics } from "../observability/metrics.js";
import type { FlightProvider, FlightSearchParams, ProviderResult } from "./types.js";
import { amadeusFlightOffersResponseSchema, amadeusTokenSchema } from "./amadeus-flight-schemas.js";

export type AmadeusEnvironment = "disabled" | "test" | "production";

export interface AmadeusFlightProviderOptions {
  environment: Exclude<AmadeusEnvironment, "disabled">;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

type AccessToken = { value: string; expiresAt: number };

const AMADEUS_BASE_URL: Record<Exclude<AmadeusEnvironment, "disabled">, string> = {
  test: "https://test.api.amadeus.com",
  production: "https://api.amadeus.com",
};

export function readAmadeusConfiguration(env: NodeJS.ProcessEnv = process.env): AmadeusFlightProviderOptions | null {
  const environment = (env.AMADEUS_ENVIRONMENT ?? "disabled").trim() as AmadeusEnvironment;
  if (environment === "disabled") return null;
  if (environment !== "test" && environment !== "production") throw new Error("AMADEUS_ENVIRONMENT must be disabled, test, or production");
  if (environment === "test" && !["development", "test"].includes(env.NODE_ENV ?? "development")) {
    throw new Error("AMADEUS_ENVIRONMENT=test is allowed only in development or test");
  }
  const clientId = env.AMADEUS_CLIENT_ID?.trim();
  const clientSecret = env.AMADEUS_CLIENT_SECRET?.trim();
  const timeoutMs = Number(env.AMADEUS_FLIGHT_TIMEOUT_MS ?? 8000);
  if (!clientId || !clientSecret) throw new Error("Amadeus client credentials are required when enabled");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("AMADEUS_FLIGHT_TIMEOUT_MS must be an integer from 100 to 30000");
  }
  return { environment, clientId, clientSecret, timeoutMs };
}

export class AmadeusFlightProvider implements FlightProvider {
  readonly providerName = "amadeus" as const;
  private token: AccessToken | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: AmadeusFlightProviderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async searchFlights(params: FlightSearchParams): Promise<ProviderResult<FlightOffer[]>> {
    const start = Date.now();
    const capturedAt = this.now().toISOString();
    try {
      const token = await this.accessToken(params.signal);
      const query = new URLSearchParams({
        originLocationCode: params.origin,
        destinationLocationCode: params.destination,
        departureDate: params.dateStart,
        adults: String(params.adults ?? 1),
        currencyCode: params.currency ?? "USD",
        max: "10",
      });
      if ((params.tripType ?? "ROUND_TRIP") === "ROUND_TRIP") query.set("returnDate", params.dateEnd);
      if (params.cabin) query.set("travelClass", params.cabin);
      const response = await this.request(`/v2/shopping/flight-offers?${query}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: params.signal,
      });
      if (response.status === 429) return this.unavailable("RATE_LIMITED", start);
      if (response.status >= 500) return this.unavailable("UPSTREAM_FAILURE", start);
      if (!response.ok) return this.unavailable("UPSTREAM_FAILURE", start);
      const payload = amadeusFlightOffersResponseSchema.safeParse(await response.json());
      if (!payload.success) return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
      if (payload.data.data.length === 0) return this.unavailable("NO_RESULTS", start);
      const queryId = randomUUID();
      const offers = payload.data.data.map((offer) => normalizeOffer(offer, {
        queryId, capturedAt, adults: params.adults ?? 1, source: "Amadeus Flight Offers Search",
      }));
      this.record("LIVE", start);
      return { outcome: "LIVE", data: offers, source: "Amadeus Flight Offers Search", capturedAt };
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return this.unavailable("UPSTREAM_TIMEOUT", start);
      return this.unavailable("UPSTREAM_FAILURE", start);
    }
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const response = await this.request("/v1/security/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials", client_id: this.options.clientId, client_secret: this.options.clientSecret,
      }),
      signal,
    });
    if (!response.ok) throw new Error("Amadeus token request failed");
    const parsed = amadeusTokenSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Amadeus token response invalid");
    this.token = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 };
    return this.token.value;
  }

  private async request(path: string, init: RequestInit & { signal?: AbortSignal }): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return this.fetchImpl(`${AMADEUS_BASE_URL[this.options.environment]}${path}`, { ...init, signal });
  }

  private unavailable(reason: Extract<ProviderResult<FlightOffer[]>, { outcome: "UNAVAILABLE" }> ["reason"], start: number): ProviderResult<FlightOffer[]> {
    this.record(reason, start);
    return { outcome: "UNAVAILABLE", reason };
  }

  private record(outcome: "LIVE" | string, start: number): void {
    const errorCategory = outcome === "LIVE" ? "none" : outcome.toLowerCase();
    metrics.inc("flight_provider_requests_total", { outcome: outcome === "LIVE" ? "live" : "unavailable", provider: "amadeus", error_category: errorCategory });
    metrics.observe("flight_provider_latency_ms", Date.now() - start, { provider: "amadeus", outcome: outcome === "LIVE" ? "live" : "unavailable" });
  }
}

function normalizeOffer(offer: ReturnType<typeof amadeusFlightOffersResponseSchema.parse>["data"][number], params: { queryId: string; capturedAt: string; adults: number; source: string }): FlightOffer {
  const firstItinerary = offer.itineraries[0];
  const firstSegment = firstItinerary.segments[0];
  const lastSegment = firstItinerary.segments.at(-1)!;
  const fareDetails = offer.travelerPricings[0].fareDetailsBySegment;
  const baggageQuantity = fareDetails[0]?.includedCheckedBags?.quantity;
  const expiresAt = offer.lastTicketingDate
    ? new Date(`${offer.lastTicketingDate}T23:59:59.999Z`).toISOString()
    : new Date(Date.parse(params.capturedAt) + 15 * 60_000).toISOString();
  return {
    id: `amadeus:${offer.id}`,
    providerOfferId: offer.id,
    providerName: "amadeus",
    queryId: params.queryId,
    origin: firstSegment.departure.iataCode,
    destination: lastSegment.arrival.iataCode,
    segments: firstItinerary.segments.map((segment) => ({
      carrierCode: segment.carrierCode,
      flightNumber: segment.number,
      origin: segment.departure.iataCode,
      destination: segment.arrival.iataCode,
      departureAt: segment.departure.at,
      arrivalAt: segment.arrival.at,
      duration: segment.duration,
    })),
    totalDuration: firstItinerary.duration,
    totalPrice: Number(offer.price.total),
    currency: offer.price.currency,
    cabin: fareDetails[0].cabin,
    adults: params.adults,
    baggageSummary: baggageQuantity === undefined ? null : `${baggageQuantity} checked bag(s) included`,
    changeSummary: null,
    source: params.source,
    capturedAt: params.capturedAt,
    expiresAt,
  };
}
