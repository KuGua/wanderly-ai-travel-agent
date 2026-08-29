import type {
  MobilityOfferProvider,
  MobilityServiceType,
  NormalizedMobilityOffer,
  ProviderResult,
} from "./types.js";
import { metrics } from "../observability/metrics.js";
import { amadeusTransferResponseSchema, type AmadeusTransferResponse } from "./amadeus-transfer-schemas.js";

export interface AmadeusTransferProviderOptions {
  environment: "test" | "production";
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

type AccessToken = { value: string; expiresAt: number };

const AMADEUS_BASE_URL: Record<"test" | "production", string> = {
  test: "https://test.api.amadeus.com",
  production: "https://api.amadeus.com",
};

const SERVICE_TYPE_TO_AMADEUS: Record<MobilityServiceType, string> = {
  TAXI: "TAXI",
  TRANSFER: "PRIVATE_TRANSFER",
  CHARTER: "CHARTER",
  RENTAL: "CAR_RENTAL",
};

/**
 * Required provider attribution string. Surfaced on every UI card that
 * shows a transfer offer.
 */
export const AMADEUS_TRANSFER_ATTRIBUTION = "Amadeus Transfer Search";

export function readAmadeusTransferConfiguration(env: NodeJS.ProcessEnv = process.env): AmadeusTransferProviderOptions | null {
  const clientId = env.AMADEUS_CLIENT_ID?.trim();
  const clientSecret = env.AMADEUS_CLIENT_SECRET?.trim();
  const environmentRaw = env.AMADEUS_ENVIRONMENT?.trim() ?? "disabled";
  if (environmentRaw === "disabled") return null;
  if (environmentRaw !== "test" && environmentRaw !== "production") {
    throw new Error("AMADEUS_ENVIRONMENT must be disabled, test, or production");
  }
  if (environmentRaw === "test" && !["development", "test"].includes(env.NODE_ENV ?? "development")) {
    throw new Error("AMADEUS_ENVIRONMENT=test is allowed only in development or test");
  }
  const timeoutMs = Number(env.AMADEUS_TRANSFER_TIMEOUT_MS ?? 8000);
  if (!clientId || !clientSecret) return null;
  if (timeoutMs < 100 || timeoutMs > 30_000 || !Number.isInteger(timeoutMs)) {
    throw new Error("AMADEUS_TRANSFER_TIMEOUT_MS must be an integer from 100 to 30000");
  }
  return { environment: environmentRaw, clientId, clientSecret, timeoutMs };
}

export class AmadeusTransferProvider implements MobilityOfferProvider {
  private token: AccessToken | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: AmadeusTransferProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.baseUrl = options.baseUrl ?? AMADEUS_BASE_URL[options.environment];
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  async searchOffers(params: {
    originPlaceId: string;
    destinationPlaceId: string;
    passengers: number;
    departureAt: string;
    serviceType: "TAXI" | "TRANSFER" | "CHARTER" | "RENTAL";
    snapshotId: string;
    runId?: string;
    signal?: AbortSignal;
  }): Promise<ProviderResult<NormalizedMobilityOffer[]>> {
    const start = Date.now();
    const capturedAt = this.now().toISOString();
    try {
      const token = await this.accessToken(params.signal);
      const amadeusService = SERVICE_TYPE_TO_AMADEUS[params.serviceType];
      const query = new URLSearchParams({
        originLocationCode: params.originPlaceId.slice(0, 3).toUpperCase(),
        destinationLocationCode: params.destinationPlaceId.slice(0, 3).toUpperCase(),
        departureDateTime: params.departureAt,
        adults: String(params.passengers),
        transportType: amadeusService,
      });
      const response = await this.request(`/v1/shopping/transfer-offers?${query.toString()}`, token, params.signal);
      if (response.status === 429) return this.unavailable("RATE_LIMITED", start);
      if (response.status >= 500) return this.unavailable("UPSTREAM_FAILURE", start);
      if (!response.ok) return this.unavailable("UPSTREAM_FAILURE", start);
      let payload: AmadeusTransferResponse;
      try {
        const parsed = amadeusTransferResponseSchema.safeParse(await response.json());
        if (!parsed.success) return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
        payload = parsed.data;
      } catch {
        return this.unavailable("INVALID_PROVIDER_RESPONSE", start);
      }
      const offers: NormalizedMobilityOffer[] = payload.data.map((offer) => normalizeOffer({
        offer,
        serviceType: params.serviceType,
        originPlaceId: params.originPlaceId,
        destinationPlaceId: params.destinationPlaceId,
        passengers: params.passengers,
        departureAt: params.departureAt,
        capturedAt,
      }));
      if (offers.length === 0) {
        return this.unavailable("NO_RESULTS", start);
      }
      this.record("LIVE", start);
      return { outcome: "LIVE", data: offers, source: AMADEUS_TRANSFER_ATTRIBUTION, capturedAt };
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") return this.unavailable("UPSTREAM_TIMEOUT", start);
      return this.unavailable("UPSTREAM_FAILURE", start);
    }
  }

  private async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const response = await this.request("/v1/security/oauth2/token", "", signal, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }).toString(),
    });
    if (!response.ok) throw new Error("Amadeus transfer token request failed");
    const data = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token || !data.expires_in) throw new Error("Amadeus transfer token response invalid");
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }

  private async request(path: string, token: string, signal?: AbortSignal, init: RequestInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal: composed });
  }

  private unavailable(
    reason: Extract<ProviderResult<NormalizedMobilityOffer[]>, { outcome: "UNAVAILABLE" }>["reason"],
    start: number,
  ): ProviderResult<NormalizedMobilityOffer[]> {
    this.record(reason, start);
    return { outcome: "UNAVAILABLE", reason };
  }

  private record(outcome: "LIVE" | string, start: number): void {
    const errorCategory = outcome === "LIVE" ? "none" : outcome.toLowerCase();
    metrics.inc("mobility_provider_requests_total", {
      outcome: outcome === "LIVE" ? "live" : "unavailable",
      provider: "amadeus-transfer",
      error_category: errorCategory,
    });
    metrics.observe("mobility_provider_latency_ms", Date.now() - start, {
      provider: "amadeus-transfer",
      outcome: outcome === "LIVE" ? "live" : "unavailable",
    });
  }
}

function normalizeOffer(params: {
  offer: AmadeusTransferResponse["data"][number];
  serviceType: MobilityServiceType;
  originPlaceId: string;
  destinationPlaceId: string;
  passengers: number;
  departureAt: string;
  capturedAt: string;
}): NormalizedMobilityOffer {
  return {
    offerId: params.offer.id,
    serviceType: params.serviceType,
    originPlaceId: params.originPlaceId,
    destinationPlaceId: params.destinationPlaceId,
    passengers: params.passengers,
    departureAt: params.offer.departureAt ?? params.departureAt,
    estimatedPrice: params.offer.estimatedPrice,
    currency: params.offer.currency,
    vehicleClass: params.offer.vehicleClass,
    estimated: true,
    expiresAt: params.offer.expiresAt ?? null,
    source: AMADEUS_TRANSFER_ATTRIBUTION,
    capturedAt: params.capturedAt,
  };
}
