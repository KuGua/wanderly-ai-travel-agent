import type { Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";

export const OPEN_MAP_TILES_SOURCE = "openmaptiles";

export const GEOGRAPHY_LAYER_IDS = {
  countries: ["boundary_2", "label_country_1", "label_country_2", "label_country_3"],
  regions: ["boundary_3", "label_state"],
  cities: ["label_city", "label_city_capital"],
} as const;

export const GEOGRAPHY_INTERACTIVE_LAYER_IDS = [
  "label_country_1",
  "label_country_2",
  "label_country_3",
  "label_state",
  ...GEOGRAPHY_LAYER_IDS.cities,
] as const;

export type GeographyVisibility = {
  countries: boolean;
  regions: boolean;
  cities: boolean;
};

export type GeographyFeature = {
  name: string;
  kind: "country" | "city" | "administrative division";
};

export type GeographyInspection = {
  supported: boolean;
  sourcePresent: boolean;
  missingLayers: readonly string[];
  styleUrl: string;
};

export function supportsGeographyLayers(map: MapLibreMap) {
  return inspectGeographyLayers(map, "").supported;
}

export function inspectGeographyLayers(map: MapLibreMap, styleUrl: string): GeographyInspection {
  const sourcePresent = Boolean(map.getSource(OPEN_MAP_TILES_SOURCE));
  const expected = Object.values(GEOGRAPHY_LAYER_IDS).flat();
  const missingLayers = sourcePresent
    ? expected.filter((layerId) => !map.getLayer(layerId))
    : expected;

  return {
    supported: sourcePresent && missingLayers.length === 0,
    sourcePresent,
    missingLayers,
    styleUrl,
  };
}

export function setGeographyLayerVisibility(map: MapLibreMap, visibility: GeographyVisibility) {
  setLayerGroupVisibility(map, GEOGRAPHY_LAYER_IDS.countries, visibility.countries);
  setLayerGroupVisibility(map, GEOGRAPHY_LAYER_IDS.regions, visibility.regions);
  setLayerGroupVisibility(map, GEOGRAPHY_LAYER_IDS.cities, visibility.cities);
}

export function applyGeographyContrast(map: MapLibreMap) {
  const boundaryPaint = [
    ["boundary_2", "#0b5264", 1.35],
    ["boundary_3", "#3a7d88", 1],
  ] as const;
  for (const [layerId, color, width] of boundaryPaint) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, "line-color", color);
    map.setPaintProperty(layerId, "line-width", width);
    map.setPaintProperty(layerId, "line-opacity", layerId === "boundary_2" ? 0.72 : 0.5);
  }

  for (const layerId of GEOGRAPHY_INTERACTIVE_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, "text-color", "#073d50");
    map.setPaintProperty(layerId, "text-halo-color", "rgba(255, 253, 249, 0.96)");
    map.setPaintProperty(layerId, "text-halo-width", 1.25);
  }
}

export function geographyFeatureFrom(feature: MapGeoJSONFeature | undefined): GeographyFeature | null {
  if (!feature?.properties) return null;
  const properties = feature.properties as Record<string, unknown>;
  const name = firstText(properties["name:zh"], properties["name:en"], properties.name);
  if (!name) return null;

  const featureClass = firstText(properties.class, properties.type, properties.place)?.toLowerCase();
  if (featureClass === "country") return { name, kind: "country" };
  if (featureClass === "city" || featureClass === "town" || featureClass === "village" || featureClass === "capital") {
    return { name, kind: "city" };
  }
  if (featureClass === "state" || featureClass === "province" || featureClass === "region") {
    return { name, kind: "administrative division" };
  }
  return null;
}

function setLayerGroupVisibility(map: MapLibreMap, layerIds: readonly string[], visible: boolean) {
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
  }
}

function firstText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}
