import type { Map as MapLibreMap, MapGeoJSONFeature } from "maplibre-gl";

export const OPEN_MAP_TILES_SOURCE = "openmaptiles";

const COUNTRY_LAYER_IDS = ["boundary_2", "label_country_1", "label_country_2", "label_country_3"] as const;
const REGION_LAYER_IDS = ["boundary_3", "label_state"] as const;
const CITY_LAYER_IDS = ["label_city", "label_city_capital"] as const;
const REQUIRED_LAYER_IDS = [...COUNTRY_LAYER_IDS, ...REGION_LAYER_IDS, ...CITY_LAYER_IDS] as const;

export const GEOGRAPHY_INTERACTIVE_LAYER_IDS = [
  "label_country_1",
  "label_country_2",
  "label_country_3",
  "label_state",
  "label_city",
  "label_city_capital",
] as const;

export type GeographyVisibility = {
  countries: boolean;
  regions: boolean;
  cities: boolean;
};

export type GeographyInspection = {
  supported: boolean;
  sourcePresent: boolean;
  missingLayers: readonly string[];
};

export function inspectGeographyLayers(map: MapLibreMap, styleUrl: string): GeographyInspection {
  void styleUrl;
  const sourcePresent = Boolean(map.getSource(OPEN_MAP_TILES_SOURCE));
  const missingLayers = sourcePresent
    ? REQUIRED_LAYER_IDS.filter((layerId) => !map.getLayer(layerId))
    : [...REQUIRED_LAYER_IDS];

  return {
    supported: sourcePresent && missingLayers.length === 0,
    sourcePresent,
    missingLayers,
  };
}

export function setGeographyLayerVisibility(map: MapLibreMap, visibility: GeographyVisibility) {
  setGroupVisibility(map, COUNTRY_LAYER_IDS, visibility.countries);
  setGroupVisibility(map, REGION_LAYER_IDS, visibility.regions);
  setGroupVisibility(map, CITY_LAYER_IDS, visibility.cities);
}

export function applyGeographyContrast(map: MapLibreMap) {
  for (const layerId of ["boundary_2", "boundary_3"] as const) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, "line-opacity", layerId === "boundary_2" ? 0.72 : 0.5);
  }
}

export function geographyFeatureFrom(feature: MapGeoJSONFeature | undefined) {
  if (!feature?.properties) return null;
  const properties = feature.properties as Record<string, unknown>;
  const name = firstText(properties["name:zh"], properties["name:en"], properties.name);
  if (!name) return null;

  const featureClass = firstText(properties.class, properties.type, properties.place)?.toLowerCase();
  const kind = featureClass === "country"
    ? "country"
    : featureClass === "state" || featureClass === "province" || featureClass === "region"
      ? "state"
      : featureClass === "city" || featureClass === "town" || featureClass === "village" || featureClass === "capital"
        ? "city"
        : null;

  return kind ? { kind, name } as const : null;
}

function setGroupVisibility(map: MapLibreMap, layerIds: readonly string[], visible: boolean) {
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
  }
}

function firstText(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}
