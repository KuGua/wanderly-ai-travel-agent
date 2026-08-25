import { describe, expect, it } from "vitest";

import { OPEN_FREEMAP_LIBERTY_LAYERS } from "./__fixtures__/openfreemap-liberty-layers";
import { GEOGRAPHY_INTERACTIVE_LAYER_IDS, GEOGRAPHY_LAYER_IDS } from "./map-geography-layers";

describe("OpenFreeMap Liberty layer ID snapshot", () => {
  it("contains every layer ID expected by GEOGRAPHY_LAYER_IDS", () => {
    const expected = new Set<string>(Object.values(GEOGRAPHY_LAYER_IDS).flat() as string[]);
    const actual = new Set<string>(OPEN_FREEMAP_LIBERTY_LAYERS.layerIds as readonly string[]);
    const missing = [...expected].filter((id) => !actual.has(id));
    expect(missing, `Layers referenced by GEOGRAPHY_LAYER_IDS but missing from the snapshot: ${missing.join(", ")}`).toEqual([]);
  });

  it("contains every layer ID expected by GEOGRAPHY_INTERACTIVE_LAYER_IDS", () => {
    const expected = new Set<string>(GEOGRAPHY_INTERACTIVE_LAYER_IDS as readonly string[]);
    const actual = new Set<string>(OPEN_FREEMAP_LIBERTY_LAYERS.layerIds as readonly string[]);
    const missing = [...expected].filter((id) => !actual.has(id));
    expect(missing, `Layers referenced by GEOGRAPHY_INTERACTIVE_LAYER_IDS but missing from the snapshot: ${missing.join(", ")}`).toEqual([]);
  });

  it("snapshot styleUrl matches the documented default", () => {
    expect(OPEN_FREEMAP_LIBERTY_LAYERS.styleUrl).toBe("https://tiles.openfreemap.org/styles/liberty");
  });
});