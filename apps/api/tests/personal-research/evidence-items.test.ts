/**
 * Evidence has to name what it found.
 *
 * These summaries used to be counts and a price band, which left the model
 * unable to answer "which one" — so it answered from its own knowledge and
 * the supplier call counted for nothing. A count alone is the regression to
 * watch for.
 */
import { describe, expect, it, vi } from "vitest";

import { PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT } from "../../src/types/schemas.js";

const run = { id: "r", createdByUserId: "u", tripId: "t", threadId: "th" } as never;
const signal = new AbortController().signal;

const mockPlace = vi.fn();
vi.mock("../../src/providers/live-provider-factory.js", () => ({
  createOrsPlace: () => ({ searchPlaces: mockPlace }),
}));

const { executePersonalPlacesSearch } = await import(
  "../../src/services/personal-research-executors/places.js"
);

describe("places evidence carries the places", () => {
  const draft = {
    kind: "PLACES_SEARCH" as const,
    latitude: 35.68, longitude: 139.69, radiusMeters: 1500,
    category: "RESTAURANT" as const, limit: 20,
  };

  it("names each candidate rather than only counting them", async () => {
    mockPlace.mockResolvedValueOnce({
      outcome: "LIVE", source: "ors", capturedAt: new Date().toISOString(),
      data: [
        { candidateId: "1", displayName: "六厘舍", kind: "RESTAURANT" },
        { candidateId: "2", displayName: "根室花丸", kind: "RESTAURANT" },
      ],
    });
    const result = await executePersonalPlacesSearch({ run, draft, signal });
    expect(result.outcome).toBe("AVAILABLE");
    if (result.outcome !== "AVAILABLE") return;
    expect(result.places?.items.map((i) => i.label)).toEqual(["六厘舍", "根室花丸"]);
    // Geocoding quotes nothing; a fabricated price would be worse than none.
    expect(result.places?.items.every((i) => i.price === null)).toBe(true);
    expect(result.places?.candidateCount).toBe(2);
  });

  it("caps the list so evidence stays a prompt input, not a catalogue", async () => {
    mockPlace.mockResolvedValueOnce({
      outcome: "LIVE", source: "ors", capturedAt: new Date().toISOString(),
      data: Array.from({ length: 20 }, (_, i) => ({
        candidateId: String(i), displayName: `Place ${i}`, kind: "RESTAURANT",
      })),
    });
    const result = await executePersonalPlacesSearch({ run, draft, signal });
    if (result.outcome !== "AVAILABLE") throw new Error("expected AVAILABLE");
    expect(result.places?.items).toHaveLength(PERSONAL_RESEARCH_EVIDENCE_ITEM_LIMIT);
    // The count still reports everything found, not just what was carried.
    expect(result.places?.candidateCount).toBe(20);
  });
});
