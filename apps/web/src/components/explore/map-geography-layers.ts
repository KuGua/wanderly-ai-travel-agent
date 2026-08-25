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

export function supportsGeographyLayers(map: MapLibreMap) {
  return inspectGeographyLayers(map, "").supported;
}

export type GeographyInspection = {
  supported: boolean;
  sourcePresent: boolean;
  missingLayers: readonly string[];
  styleUrl: string;
};

export function inspectGeographyLayers(map: MapLibreMap, styleUrl: string): GeographyInspection {
  const sourcePresent = Boolean(map.getSource(OPEN_MAP_TILES_SOURCE));
  const expected = Object.values(GEOGRAPHY_LAYER_IDS).flat();
  const missingLayers = sourcePresent
    ? expected.filter((id) => !map.getLayer(id))
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
  map.setPaintProperty("boundary_2", "line-color", "#0b5264");
  map.setPaintProperty("boundary_2", "line-width", 1.35);
  map.setPaintProperty("boundary_3", "line-color", "#3a7d88");
  map.setPaintProperty("boundary_3", "line-width", 1);
  ["label_country_1", "label_country_2", "label_country_3", "label_state", "label_city", "label_city_capital"].forEach((id) => {
    map.setPaintProperty(id, "text-color", "#073d50");
    map.setPaintProperty(id, "text-halo-color", "rgba(255, 253, 249, 0.96)");
    map.setPaintProperty(id, "text-halo-width", 1.25);
  });
}

export function geographyFeatureFrom(feature: MapGeoJSONFeature | undefined): GeographyFeature | null {
  if (!feature) return null;

  const featureClass = feature.properties.class;
  const name = preferredName(feature.properties);
  if (!name) return null;
  if (featureClass === "country") return { name, kind: "country" };
  if (featureClass === "city") return { name, kind: "city" };
  if (featureClass === "state" || featureClass === "province") return { name, kind: "administrative division" };
  return null;
}

function setLayerGroupVisibility(map: MapLibreMap, ids: readonly string[], visible: boolean) {
  ids.forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  });
}

function preferredName(properties: MapGeoJSONFeature["properties"]) {
  return stringValue(properties["name:zh"]) ?? stringValue(properties["name:en"]) ?? stringValue(properties.name);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
