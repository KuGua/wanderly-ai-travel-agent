/**
 * OpenFreeMap Liberty style layer ID snapshot.
 *
 * Manually curated. When OpenFreeMap upgrades Liberty or the style URL moves,
 * fetch https://tiles.openfreemap.org/styles/liberty and verify these 8 IDs
 * (the ones referenced by GEOGRAPHY_LAYER_IDS in map-geography-layers.ts)
 * still exist. Update `capturedAt` when refreshing.
 *
 * We intentionally do not snapshot all ~110 layers — the test only asserts
 * intersection against the IDs the explorer actually depends on, so a drift
 * in unrelated labels does not fail CI.
 */
export const OPEN_FREEMAP_LIBERTY_LAYERS = {
  styleUrl: "https://tiles.openfreemap.org/styles/liberty",
  capturedAt: "2026-08-25T00:00:00.000Z",
  layerIds: [
    "boundary_2",
    "boundary_3",
    "label_country_1",
    "label_country_2",
    "label_country_3",
    "label_state",
    "label_city",
    "label_city_capital",
  ],
} as const;