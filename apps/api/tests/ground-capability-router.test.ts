import { describe, expect, it } from "vitest";
import { createGroundCapabilityRouter } from "../src/providers/ground-capability-router.js";
import type {
  MobilityOfferProvider,
  NavigationProvider,
  NormalizedMobilityOffer,
  NormalizedRouteEvidence,
  PlaceSearchProvider,
  ProviderResult,
  TransitJourneyProvider,
} from "../src/providers/types.js";
import type { NormalizedPlaceCandidate, NormalizedTransitJourney } from "../src/providers/types.js";

class StubPlaceProvider implements PlaceSearchProvider {
  constructor(private readonly result: ProviderResult<NormalizedPlaceCandidate[]>) {}
  async searchPlaces(): Promise<ProviderResult<NormalizedPlaceCandidate[]>> {
    return this.result;
  }
}

class StubNavigationProvider implements NavigationProvider {
  constructor(private readonly result: ProviderResult<NormalizedRouteEvidence>) {}
  async searchRoute(): Promise<ProviderResult<NormalizedRouteEvidence>> {
    return this.result;
  }
}

class StubMobilityProvider implements MobilityOfferProvider {
  constructor(private readonly result: ProviderResult<NormalizedMobilityOffer[]>) {}
  async searchOffers(): Promise<ProviderResult<NormalizedMobilityOffer[]>> {
    return this.result;
  }
}

class StubTransitProvider implements TransitJourneyProvider {
  constructor(private readonly result: ProviderResult<NormalizedTransitJourney[]>) {}
  async searchJourneys(): Promise<ProviderResult<NormalizedTransitJourney[]>> {
    return this.result;
  }
}

describe("createGroundCapabilityRouter", () => {
  it("exposes each capability as the configured provider", () => {
    const place = new StubPlaceProvider({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
    const navigation = new StubNavigationProvider({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
    const mobility = new StubMobilityProvider({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
    const transit = new StubTransitProvider({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" });
    const router = createGroundCapabilityRouter({
      placeProvider: place,
      navigationProvider: navigation,
      mobilityOfferProvider: mobility,
      transitJourneyProvider: transit,
    });
    expect(router.place).toBe(place);
    expect(router.navigation).toBe(navigation);
    expect(router.mobility).toBe(mobility);
    expect(router.transit).toBe(transit);
  });

  it("forwards calls to the configured provider without leaking identity", async () => {
    const live: NormalizedRouteEvidence = {
      originPlaceId: "11111111-1111-4111-8111-111111111111",
      destinationPlaceId: "22222222-2222-4222-8222-222222222222",
      mode: "WALK",
      distanceMeters: 100,
      durationSeconds: 60,
      steps: [],
      encodedGeometry: "abc",
      source: "ors",
      capturedAt: "2026-09-01T00:00:00.000Z",
      refreshAfter: "2026-09-02T00:00:00.000Z",
    };
    const navigation = new StubNavigationProvider({ outcome: "LIVE", data: live, source: "ors", capturedAt: live.capturedAt });
    const router = createGroundCapabilityRouter({
      placeProvider: new StubPlaceProvider({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" }),
      navigationProvider: navigation,
      mobilityOfferProvider: new StubMobilityProvider({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" }),
      transitJourneyProvider: new StubTransitProvider({ outcome: "UNAVAILABLE", reason: "NOT_CONFIGURED" }),
    });
    const result = await router.navigation.searchRoute({
      originPlaceId: live.originPlaceId,
      destinationPlaceId: live.destinationPlaceId,
      mode: "WALK",
      snapshotId: "33333333-3333-4333-8333-333333333333",
    });
    expect(result.outcome).toBe("LIVE");
    if (result.outcome === "LIVE") {
      expect(result.data).toEqual(live);
    }
  });
});