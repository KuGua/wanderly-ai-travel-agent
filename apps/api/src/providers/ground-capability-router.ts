import type {
  MobilityOfferProvider,
  NavigationProvider,
  PlaceSearchProvider,
  TransitJourneyProvider,
} from "./types.js";

/**
 * Spec §3 — `GroundCapabilityRouter` is the single provider selection point.
 *
 * The router is the only place that decides which concrete supplier backs a
 * given capability. The model never chooses a provider; this surface enforces
 * that by exposing no provider identity in any return value, and by making
 * the selection deterministic and auditable from a single table.
 *
 * Fallbacks are only allowed between semantically equivalent providers (same
 * capability and same data class) and must record a `fallbackReason`. No
 * provider-to-provider fallback crosses `Navigation` ↔ `Mobility` ↔ `Transit`
 * ↔ `Place`.
 *
 * In this milestone the router simply forwards to the configured provider.
 * Future country/region allow-lists and feature flags will be added here.
 */
export interface GroundCapabilityRouter {
  readonly place: PlaceSearchProvider;
  readonly navigation: NavigationProvider;
  readonly mobility: MobilityOfferProvider;
  readonly transit: TransitJourneyProvider;
}

export interface GroundCapabilityRouterDeps {
  placeProvider: PlaceSearchProvider;
  navigationProvider: NavigationProvider;
  mobilityOfferProvider: MobilityOfferProvider;
  transitJourneyProvider: TransitJourneyProvider;
}

export function createGroundCapabilityRouter(deps: GroundCapabilityRouterDeps): GroundCapabilityRouter {
  // Deterministic 1:1 mapping. Future allow-lists / feature flags land here
  // without changing the public surface.
  return {
    place: deps.placeProvider,
    navigation: deps.navigationProvider,
    mobility: deps.mobilityOfferProvider,
    transit: deps.transitJourneyProvider,
  };
}