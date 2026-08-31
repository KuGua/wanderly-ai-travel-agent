import type {
  AccommodationDiscoveryProvider,
  ActivitiesProvider,
  FlightProvider,
  HotelOfferProviderName,
  HotelProvider,
  MobilityOfferProvider,
  NavigationProvider,
  PlaceSearchProvider,
  ProviderResult,
  StayProvider,
  TransitJourneyProvider,
} from "./types.js";
import type {
  NormalizedMobilityOffer,
  NormalizedPlaceCandidate,
  NormalizedRouteEvidence,
  NormalizedTransitJourney,
} from "./types.js";
import type { FlightOffer, StayOffer } from "../types/domain.js";
import { AmadeusFlightProvider, readAmadeusConfiguration } from "./amadeus-flight-provider.js";
import { FlightApiProvider, readFlightApiConfiguration } from "./flightapi-flight-provider.js";
import { SerpApiFlightProvider, readSerpApiConfiguration } from "./serpapi-flight-provider.js";
import { AmadeusTransferProvider, readAmadeusTransferConfiguration } from "./amadeus-transfer-provider.js";
import { OrsPlaceProvider, readOrsPlaceConfiguration } from "./ors-place-provider.js";
import { OrsNavigationProvider, readOrsNavigationConfiguration } from "./ors-navigation-provider.js";
import { ViatorMcpActivitiesProvider, readViatorMcpConfiguration } from "./viator-mcp-activities-provider.js";
import { SerpApiHotelProvider, readSerpApiHotelConfiguration } from "./serpapi-hotel-provider.js";
import { NuiteeHotelProvider, readNuiteeHotelConfiguration } from "./nuitee-hotel-provider.js";
import {
  OpenTripMapAccommodationProvider,
  readOpenTripMapAccommodationConfiguration,
} from "./opentripmap-accommodation-provider.js";
import { db } from "../db/database.js";
import { agentTaskRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";

class UnavailableFlightProvider implements FlightProvider {
  readonly providerName = "unconfigured" as const;
  async searchFlights(): Promise<ProviderResult<FlightOffer[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableStayProvider implements StayProvider {
  async searchStays(): Promise<ProviderResult<StayOffer[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailablePlaceProvider implements PlaceSearchProvider {
  async searchPlaces(): Promise<ProviderResult<NormalizedPlaceCandidate[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableNavigationProvider implements NavigationProvider {
  async searchRoute(): Promise<ProviderResult<NormalizedRouteEvidence>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableMobilityOfferProvider implements MobilityOfferProvider {
  async searchOffers(): Promise<ProviderResult<NormalizedMobilityOffer[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableTransitJourneyProvider implements TransitJourneyProvider {
  async searchJourneys(): Promise<ProviderResult<NormalizedTransitJourney[]>> {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" };
  }
}

class UnavailableActivitiesProvider implements ActivitiesProvider {
  async searchActivities() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" } as const;
  }
}

class UnavailableHotelProvider implements HotelProvider {
  readonly providerName = "unconfigured" as const;
  readonly source = "Not configured" as const;
  async searchHotels() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" } as const;
  }
}

class UnavailableAccommodationDiscoveryProvider implements AccommodationDiscoveryProvider {
  async discoverAccommodations() {
    return { outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" } as const;
  }
}

/**
 * The product never substitutes invented offers. Concrete supplier adapters are
 * registered here only after their credentials and commercial terms are
 * configured; until then planning reports the affected capability unavailable.
 *
 * Spec §3: each capability is selected by a single deterministic port. The
 * model never chooses a provider; fallbacks only happen between semantically
 * equivalent suppliers and must be auditable.
 */
export function createTravelProviders(): {
  flightProvider: FlightProvider;
  stayProvider: StayProvider;
  placeProvider: PlaceSearchProvider;
  navigationProvider: NavigationProvider;
  mobilityOfferProvider: MobilityOfferProvider;
  transitJourneyProvider: TransitJourneyProvider;
  activitiesProvider: ActivitiesProvider;
  hotelProvider: HotelProvider;
  accommodationDiscoveryProvider: AccommodationDiscoveryProvider;
} {
  return {
    flightProvider: createFlightProvider(),
    stayProvider: new UnavailableStayProvider(),
    placeProvider: createOrsPlace(),
    navigationProvider: createOrsNavigation(),
    mobilityOfferProvider: createAmadeusTransfer(),
    transitJourneyProvider: new UnavailableTransitJourneyProvider(),
    activitiesProvider: createActivitiesProvider(),
    hotelProvider: createHotelProvider(),
    accommodationDiscoveryProvider: createAccommodationDiscoveryProvider(),
  };
}

export function createFlightProvider(env: NodeJS.ProcessEnv = process.env): FlightProvider {
  const selected = (env.FLIGHT_PROVIDER ?? "disabled").trim().toLowerCase();
  if (selected === "disabled") return new UnavailableFlightProvider();
  if (selected === "amadeus") {
    const configuration = readAmadeusConfiguration(env);
    if (!configuration) throw new Error("FLIGHT_PROVIDER=amadeus requires AMADEUS_ENVIRONMENT=test or production");
    return new AmadeusFlightProvider(configuration);
  }
  if (selected === "flightapi") {
    return new FlightApiProvider(readFlightApiConfiguration(env));
  }
  if (selected === "serpapi") {
    return new SerpApiFlightProvider(readSerpApiConfiguration(env));
  }
  throw new Error("FLIGHT_PROVIDER must be disabled, amadeus, flightapi, or serpapi");
}

function createAccommodationDiscoveryProvider(): AccommodationDiscoveryProvider {
  const configuration = readOpenTripMapAccommodationConfiguration();
  return configuration
    ? new OpenTripMapAccommodationProvider(configuration)
    : new UnavailableAccommodationDiscoveryProvider();
}

function createHotelProvider(env: NodeJS.ProcessEnv = process.env): HotelProvider {
  const resolved = resolvePersistedHotelProviderName(env);
  if (resolved === null) {
    const reason = (env.HOTEL_PROVIDER ?? "disabled").trim().toLowerCase() === "serpapi"
      ? "serpapi (NOT_CONFIGURED — SERPAPI_HOTEL_ENABLED or SERPAPI_API_KEY missing)"
      : (env.HOTEL_PROVIDER ?? "disabled").trim().toLowerCase() === "nuitee"
        ? "nuitee (NOT_CONFIGURED — NUITEE_API_KEY missing)"
        : `disabled (HOTEL_PROVIDER=${(env.HOTEL_PROVIDER ?? "disabled").trim() || "disabled"})`;
    logHotelProviderSelection(reason);
    return new UnavailableHotelProvider();
  }
  logHotelProviderSelection(resolved);
  if (resolved === "serpapi_google_hotels") {
    return new SerpApiHotelProvider(readSerpApiHotelConfiguration(env)!);
  }
  // resolved === "nuitee_connect"
  return new NuiteeHotelProvider(readNuiteeHotelConfiguration(env)!);
}

/**
 * Resolves the `HOTEL_PROVIDER` env value to the canonical
 * `HotelOfferProviderName` that should be persisted on
 * `agent_task_runs.hotel_provider` at task acceptance.
 *
 * Returns `null` when no real adapter is configured for the requested
 * selection (`disabled`, unknown value, or `nuitee` while the adapter
 * is still pending Phase C). Returning `null` lets the caller persist
 * `NULL` on the row; the planner then sees the hotel search return
 * `UNAVAILABLE/NOT_CONFIGURED` and reports it as a ServiceGap. This is
 * the spec §3.1 invariant: a task bound to no provider never silently
 * picks one at call time.
 */
export function resolvePersistedHotelProviderName(env: NodeJS.ProcessEnv = process.env): HotelOfferProviderName | null {
  const selected = (env.HOTEL_PROVIDER ?? "disabled").trim().toLowerCase();
  if (selected === "serpapi") {
    return readSerpApiHotelConfiguration(env) ? "serpapi_google_hotels" : null;
  }
  if (selected === "nuitee") {
    return readNuiteeHotelConfiguration(env) ? "nuitee_connect" : null;
  }
  return null;
}

/**
 * Resolve the live `HotelProvider` adapter for the named provider.
 * Used by the planner service to convert the persisted
 * `hotel_provider` value into an actual instance at run time. Falls
 * back to `UnavailableHotelProvider` when the bound provider's adapter
 * cannot be constructed (e.g. credentials revoked after acceptance);
 * the skill will then return `UNAVAILABLE/NOT_CONFIGURED` rather than
 * silently swapping providers. Spec §3.1.
 */
export function resolveHotelProviderByName(name: HotelOfferProviderName): HotelProvider {
  if (name === "serpapi_google_hotels") {
    const configuration = readSerpApiHotelConfiguration();
    return configuration ? new SerpApiHotelProvider(configuration) : new UnavailableHotelProvider();
  }
  if (name === "nuitee_connect") {
    const configuration = readNuiteeHotelConfiguration();
    return configuration ? new NuiteeHotelProvider(configuration) : new UnavailableHotelProvider();
  }
  return new UnavailableHotelProvider();
}

/**
 * Resolve the hotel provider bound to an agent task run. Returns the
 * persisted `hotel_provider` value if set, otherwise falls back to the
 * current env value (cached at task acceptance). Returns
 * `UnavailableHotelProvider` when neither side yields a real adapter.
 *
 * The function is intentionally pure: it does not mutate any state and
 * never reads credentials outside the standard env readers. Planner
 * service calls it once per `hotel.search` invocation; the result is
 * cached for the lifetime of the run via `HotelSearchExecutionContext`.
 *
 * Spec §3.1, §3.2.
 */
export async function resolveBoundHotelProvider(
  agentTaskRunId: string | undefined,
  options: {
    loadQuoteNationality?: typeof import("../services/stay-search-provider-authorization.js").loadActiveQuoteNationality;
  } = {},
): Promise<{
  providerName: import("./types.js").HotelOfferProviderName;
  adapter: HotelProvider;
  authorization?: { id: string; version: number };
}> {
  if (agentTaskRunId) {
    const [row] = await db.select({ hotelProvider: agentTaskRuns.hotelProvider })
      .from(agentTaskRuns)
      .where(eq(agentTaskRuns.id, agentTaskRunId))
      .limit(1);
    if (row?.hotelProvider) {
      const adapter = resolveHotelProviderByName(row.hotelProvider);
      const authorization = row.hotelProvider === "nuitee_connect" && options.loadQuoteNationality
        ? await resolveNuiteeAuthorization(agentTaskRunId, options.loadQuoteNationality)
        : undefined;
      return {
        providerName: row.hotelProvider,
        adapter,
        ...(authorization ? { authorization } : {}),
      };
    }
  }
  const fallbackName = resolvePersistedHotelProviderName();
  if (fallbackName === null) {
    const adapter = new UnavailableHotelProvider();
    // Adapter always exposes `providerName` in the broader union; the
    // persisted/run-bound `HotelOfferProviderName` stays `null` in this
    // fallback path. The skill reads the adapter's identity and the
    // skill-internal `providerName` field tracks the run-bound intent.
    return { providerName: "serpapi_google_hotels", adapter };
  }
  return { providerName: fallbackName, adapter: resolveHotelProviderByName(fallbackName) };
}

async function resolveNuiteeAuthorization(
  agentTaskRunId: string,
  loadQuoteNationality: typeof import("../services/stay-search-provider-authorization.js").loadActiveQuoteNationality,
): Promise<{ id: string; version: number } | undefined> {
  const [row] = await db.select({
    tripId: agentTaskRuns.tripId,
    createdByUserId: agentTaskRuns.createdByUserId,
  }).from(agentTaskRuns).where(eq(agentTaskRuns.id, agentTaskRunId)).limit(1);
  if (!row) return undefined;
  if (!row.createdByUserId || !row.tripId) return undefined;
  const loaded = await loadQuoteNationality({ tripId: row.tripId, memberId: row.createdByUserId });
  return loaded ? { id: loaded.id, version: loaded.version } : undefined;
}

function logHotelProviderSelection(selection: string | HotelOfferProviderName): void {
  // Boot-time INFO; never includes keys, request URLs, or any offer data.
  // Production logs use the structured logger; this falls back to console
  // when running before the logger is wired (CLI tools, ad-hoc scripts).
  const line = `[hotel] provider selection: ${selection}`;
  if (typeof console !== "undefined") console.info(line);
}

function createActivitiesProvider(): ActivitiesProvider {
  const configuration = readViatorMcpConfiguration();
  return configuration
    ? new ViatorMcpActivitiesProvider(configuration)
    : new UnavailableActivitiesProvider();
}

function createOrsPlace(): PlaceSearchProvider {
  const configuration = readOrsPlaceConfiguration();
  return configuration ? new OrsPlaceProvider(configuration) : new UnavailablePlaceProvider();
}

function createOrsNavigation(): NavigationProvider {
  const configuration = readOrsNavigationConfiguration();
  return configuration ? new OrsNavigationProvider(configuration) : new UnavailableNavigationProvider();
}

function createAmadeusTransfer(): MobilityOfferProvider {
  if (process.env.PLAN_ENABLE_MOBILITY === "false") {
    return new UnavailableMobilityOfferProvider();
  }
  const configuration = readAmadeusTransferConfiguration();
  return configuration ? new AmadeusTransferProvider(configuration) : new UnavailableMobilityOfferProvider();
}
