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
export const GEBCO_MIN_ZOOM = 2.5;

const RELIEF_RASTER_OPACITY: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 0, 0.78, 3, 0.7, 6, 0.5];

// Half-stop offsets around the source's min/max zoom keep the relief visible
// at the edges while the opacity expression below fades GEBCO in/out. Without
// this band the layer would snap on/off (raster-fade-duration is 0), producing
// the "suddenly lighter" jump between zoomed-in and zoomed-out views.
const GEBCO_FADE_IN_START = GEBCO_MIN_ZOOM - 0.5;
const GEBCO_FADE_OUT_END = 5.5;
const GEBCO_RASTER_OPACITY: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  GEBCO_FADE_IN_START,
  0,
  GEBCO_MIN_ZOOM,
  1,
  5,
  1,
  GEBCO_FADE_OUT_END,
  0,
];

/**
 * Adds GEBCO's opaque global relief below OpenFreeMap's vector details. The
 * bundled Natural Earth raster remains beneath it as the no-extra-request
 * fallback when GEBCO tiles are unavailable.
 *
 * GEBCO only kicks in at `GEBCO_MIN_ZOOM` and above: at very low zoom the WMS
 * tiles cover huge bboxes and the remote server is visibly slow, so the
 * Natural Earth raster (already in the style, no extra request) carries the
 * relief there. Above `GEBCO_MIN_ZOOM`, GEBCO adds the bathymetric detail the
 * Natural Earth mosaic lacks.
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
      return {
        ...layer,
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
          "fill-opacity": 0.16,
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
        tileSize: 512,
        // Source must cover the fade-in/fade-out band so MapLibre has tiles
        // available while the layer's raster-opacity ramps up at GEBCO_MIN_ZOOM
        // and back down at GEBCO_FADE_OUT_END.
        minzoom: GEBCO_FADE_IN_START,
        maxzoom: GEBCO_FADE_OUT_END,
        attribution: '<a href="https://www.gebco.net/" target="_blank" rel="noopener noreferrer">GEBCO</a> — not for navigation',
      },
    },
    layers,
  };
}
