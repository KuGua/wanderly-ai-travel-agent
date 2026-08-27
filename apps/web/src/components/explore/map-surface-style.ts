import type { ExpressionSpecification, RasterLayerSpecification, StyleSpecification } from "maplibre-gl";

export const WANDERLY_LAND_COLOR = "#d8e2b7";
export const WANDERLY_OCEAN_COLOR = "#398ea9";
export const COUNTRY_BOUNDARY_LOD_DATA_URLS = {
  lod0: "/map-data/country-borders-lod0.geojson",
  lod1: "/map-data/country-borders-lod1.geojson",
} as const;
export const CHINA_MARITIME_LINE_DATA_URL = "/map-data/china-maritime-line.geojson";
export const COUNTRY_BOUNDARY_TILE_INDEX_URL = "/map-data/country-borders-lod3/index.json";

export function countryBoundaryTileUrl(key: string) {
  return `/map-data/country-borders-lod3/${key}.geojson`;
}
export const GEBCO_SOURCE_ID = "gebco-global-relief";
export const GEBCO_LAYER_ID = "gebco-global-relief";
export const GEBCO_WMS_TILE_URL = "https://wms.gebco.net/mapserv?service=WMS&version=1.1.1&request=GetMap&layers=GEBCO_LATEST&styles=&format=image/png&transparent=FALSE&srs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512";
// Natural Earth's relief is an always-available fallback, but its ocean is
// intentionally pale. Start GEBCO at the default globe zoom so the finished
// globe has a coherent sea-and-land surface; its coarser logical tile size
// below keeps the public WMS request fan-out bounded.
export const GEBCO_MIN_ZOOM = 2.25;
// With a 1024px logical tile MapLibre selects one lower source zoom than its
// camera zoom. Keep this source floor separate from the display threshold so
// the default globe can fetch the coarser GEBCO tiles it needs.
export const GEBCO_SOURCE_MIN_ZOOM = 1;
// GEBCO publishes raster source levels through z6. MapLibre can overzoom the
// final level, which is preferable to removing terrain and exposing a blank
// ocean while vector details continue to load.
export const GEBCO_MAX_ZOOM = 6;
export const GEBCO_TILE_SIZE = 1024;

const RELIEF_RASTER_OPACITY: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 0, 0.78, 3, 0.7, 6, 0.5];

const GEBCO_RASTER_OPACITY: ExpressionSpecification = 1;

/**
 * Adds GEBCO's opaque global relief below OpenFreeMap's vector details. The
 * bundled Natural Earth raster remains beneath it as the no-extra-request
 * fallback when GEBCO tiles are unavailable.
 *
 * GEBCO requests tiles from `GEBCO_MIN_ZOOM` upward, but treats each 512px WMS
 * response as a 1024px logical tile. This reduces request fan-out on the
 * globe while preserving the colored sea-and-land surface; Natural Earth
 * remains visible while GEBCO is in flight or unavailable.
 */
export function solidifyGlobeStyle(style: StyleSpecification): StyleSpecification {
  const layers = style.layers.map((layer) => {
    if (layer.type === "background") {
      return {
        ...layer,
        paint: {
          ...layer.paint,
          "background-color": WANDERLY_OCEAN_COLOR,
          "background-opacity": 1,
        },
      };
    }

    if (layer.type === "raster" && layer.id === "natural_earth") {
      // The Liberty layer has maxzoom: 7. Do not remove the only guaranteed
      // land texture past that point: MapLibre can safely overzoom its z6
      // source tiles until provider vector details have arrived.
      const naturalEarthLayer = { ...layer };
      delete naturalEarthLayer.maxzoom;
      return {
        ...naturalEarthLayer,
        layout: { ...layer.layout, visibility: "visible" as const },
        paint: {
          ...layer.paint,
          "raster-opacity": RELIEF_RASTER_OPACITY,
          // Restore enough saturation/contrast to read as colored terrain at
          // low zoom (where this raster is the only land source). The previous
          // 0.05 saturation rendered continents almost grayscale, which
          // produced the "washed-out" look users reported when zoomed out.
          "raster-brightness-min": 0.04,
          "raster-brightness-max": 0.95,
          "raster-saturation": 0.35,
          "raster-contrast": 0.18,
          "raster-fade-duration": 0,
        },
      };
    }

    if (layer.type === "fill" && layer["source-layer"] === "water") {
      return {
        ...layer,
        paint: {
          ...layer.paint,
          "fill-color": WANDERLY_OCEAN_COLOR,
          // When GEBCO is deferred or unavailable, a translucent water fill
          // reveals the pale Natural Earth ocean and makes the globe look as
          // though tiles are missing. Keep the base ocean solid instead.
          "fill-opacity": 1,
        },
      };
    }

    if (layer.type === "line" && layer["source-layer"] === "waterway") {
      return {
        ...layer,
        paint: { ...layer.paint, "line-color": WANDERLY_OCEAN_COLOR },
      };
    }

    return layer;
  });
  const naturalEarthIndex = layers.findIndex((layer) => layer.id === "natural_earth");
  const gebcoLayer: RasterLayerSpecification = {
    id: GEBCO_LAYER_ID,
    type: "raster",
    source: GEBCO_SOURCE_ID,
    paint: {
      "raster-opacity": GEBCO_RASTER_OPACITY,
      "raster-brightness-min": 0.02,
      "raster-brightness-max": 0.94,
      "raster-saturation": -0.28,
      "raster-contrast": 0.08,
      "raster-fade-duration": 0,
    },
  };
  layers.splice(naturalEarthIndex < 0 ? 1 : naturalEarthIndex + 1, 0, gebcoLayer);

  return {
    ...style,
    sources: {
      ...style.sources,
      [GEBCO_SOURCE_ID]: {
        type: "raster",
        tiles: [GEBCO_WMS_TILE_URL],
        // Lower request fan-out for the public WMS. The WMS image remains
        // 512px, but MapLibre displays it as a 1024px logical tile; detailed
        // roads and labels still arrive from the vector style above it.
        tileSize: GEBCO_TILE_SIZE,
        minzoom: GEBCO_SOURCE_MIN_ZOOM,
        maxzoom: GEBCO_MAX_ZOOM,
        attribution: '<a href="https://www.gebco.net/" target="_blank" rel="noopener noreferrer">GEBCO</a> — not for navigation',
      },
    },
    layers,
  };
}
