import { render, waitFor } from "@testing-library/react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CountryBoundaryOverlay } from "./country-boundary-overlay";

const collection: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [{
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[[1, 2], [3, 4], [1, 2]]] },
  }],
};

describe("CountryBoundaryOverlay fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only renders fallback strokes when requested", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => collection,
    }));
    const map = {
      getContainer: () => ({ clientWidth: 400, clientHeight: 300 }),
      getCenter: () => ({ lng: 0, lat: 0 }),
      project: ([longitude, latitude]: [number, number]) => ({ x: longitude * 10, y: latitude * 10 }),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as MapLibreMap;

    const view = render(<CountryBoundaryOverlay map={map} visible={false} />);

    expect(view.container.querySelector("[data-wanderly-country-boundaries='true']")).toBeNull();

    view.rerender(<CountryBoundaryOverlay map={map} visible />);
    await waitFor(() => expect(view.container.querySelector("path[stroke='#073d50']")).not.toBeNull());
    expect(map.on).toHaveBeenCalledWith("render", expect.any(Function));
    expect(map.on).not.toHaveBeenCalledWith("move", expect.any(Function));
  });
});
