import { describe, expect, it } from "vitest";

import {
  buildPlanningEvidenceCatalog,
  PLANNING_EVIDENCE_CATALOG_MAX_ITEMS,
} from "../src/services/planning-service.js";

/**
 * Pre-researched one-shot tools are withdrawn before synthesis. The catalog is
 * therefore the model's only way to see their selectable ids, but it must stay
 * bounded and must not become a path for raw provider/private data.
 */
describe("planning evidence catalog", () => {
  it("exposes bounded public selection facts and keeps server-only fields out", () => {
    const hotels = Array.from({ length: PLANNING_EVIDENCE_CATALOG_MAX_ITEMS + 2 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      destinationId: "Shanghai",
      propertyName: `Hotel ${index}`,
      checkIn: "2026-10-01",
      checkOut: "2026-10-06",
      totalPrice: 1000 + index,
      pricePerNight: 200,
      currency: "CNY",
      cancellationSummary: null,
      source: "Test provider",
      capturedAt: "2026-09-06T00:00:00.000Z",
      providerSecret: "must-not-leave-the-server",
    }));

    const catalog = buildPlanningEvidenceCatalog({
      flights: [], activities: [], accommodations: [], hotels: hotels as never,
    });

    expect(catalog.hotels).toHaveLength(PLANNING_EVIDENCE_CATALOG_MAX_ITEMS);
    expect(catalog.hotels[0]).toMatchObject({
      id: hotels[0].id,
      propertyName: hotels[0].propertyName,
      source: "Test provider",
      capturedAt: "2026-09-06T00:00:00.000Z",
    });
    expect(catalog.hotels[0]).not.toHaveProperty("providerSecret");
    expect(catalog).not.toHaveProperty("stays");
  });
});
