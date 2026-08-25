"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useState } from "react";

import { CHINA_COUNTRY_BOUNDARY_DATA_URL, GLOBAL_COUNTRY_BOUNDARY_DATA_URL } from "./map-surface-style";

type Projector = (coordinates: [number, number]) => { x: number; y: number };
type BoundaryData = {
  global: GeoJSON.FeatureCollection;
  china: GeoJSON.FeatureCollection | null;
};

const CHINA_NATURAL_EARTH_CODES = new Set(["CHN", "TWN"]);

export function globalBoundariesWithoutChina(collection: GeoJSON.FeatureCollection) {
  return {
    ...collection,
    features: collection.features.filter((feature) => {
      const code = feature.properties?.ADM0_A3;
      return typeof code !== "string" || !CHINA_NATURAL_EARTH_CODES.has(code);
    }),
  } satisfies GeoJSON.FeatureCollection;
}

export function projectCountryBoundaryPaths(
  collection: GeoJSON.FeatureCollection,
  project: Projector,
  viewportWidth: number,
  isVisible: (coordinates: [number, number]) => boolean = () => true,
): string[] {
  return collection.features.flatMap((feature) => {
    if (!feature.geometry) return [];
    const polygons = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.type === "MultiPolygon"
        ? feature.geometry.coordinates
        : [];
    return polygons.map((polygon) => pathForPolygon(polygon, project, viewportWidth, isVisible)).filter((path): path is string => Boolean(path));
  });
}

export function isCoordinateOnVisibleHemisphere(coordinates: [number, number], center: [number, number]) {
  const longitudeDelta = degreesToRadians(coordinates[0] - center[0]);
  const latitude = degreesToRadians(coordinates[1]);
  const centerLatitude = degreesToRadians(center[1]);
  return Math.sin(latitude) * Math.sin(centerLatitude)
    + Math.cos(latitude) * Math.cos(centerLatitude) * Math.cos(longitudeDelta) >= 0;
}

function pathForPolygon(
  coordinates: number[][][],
  project: Projector,
  viewportWidth: number,
  isVisible: (coordinates: [number, number]) => boolean,
) {
  return coordinates.map((ring) => {
    let previous: { x: number; y: number } | null = null;
    return ring.reduce<string>((path, coordinate) => {
      const position: [number, number] = [coordinate[0], coordinate[1]];
      if (!isVisible(position)) {
        previous = null;
        return path;
      }
      const point = project(position);
      const startsVisibleSegment = previous === null;
      const wrapsAcrossGlobe = previous && Math.abs(point.x - previous.x) > viewportWidth * 0.45;
      previous = point;
      return `${path}${path === "" || startsVisibleSegment || wrapsAcrossGlobe ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)} `;
    }, "");
  }).join("");
}

function degreesToRadians(value: number) {
  return value * Math.PI / 180;
}

export function CountryBoundaryOverlay({ map, visible }: { map: MapLibreMap | null; visible: boolean }) {
  const [data, setData] = useState<BoundaryData | null>(null);
  const [paths, setPaths] = useState<{ global: string[]; china: string[] }>({ global: [], china: [] });

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetchBoundaryCollection(GLOBAL_COUNTRY_BOUNDARY_DATA_URL),
      fetchBoundaryCollection(CHINA_COUNTRY_BOUNDARY_DATA_URL).catch(() => null),
    ]).then(([global, china]) => {
      if (active) setData({ global, china });
    })
      .catch(() => {
        if (active) setData(null);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!map || !data) return;
    let frame: number | null = null;
    const redraw = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const container = map.getContainer();
        const center = map.getCenter();
        const project = (collection: GeoJSON.FeatureCollection) => projectCountryBoundaryPaths(
          collection,
          (coordinates) => map.project(coordinates),
          container.clientWidth,
          (coordinates) => isCoordinateOnVisibleHemisphere(coordinates, [center.lng, center.lat]),
        );
        setPaths({
          global: project(data.china ? globalBoundariesWithoutChina(data.global) : data.global),
          china: data.china ? project(data.china) : [],
        });
      });
    };
    redraw();
    map.on("move", redraw);
    map.on("resize", redraw);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      map.off("move", redraw);
      map.off("resize", redraw);
    };
  }, [data, map]);

  if (!visible || (paths.global.length === 0 && paths.china.length === 0)) return null;
  return (
    <svg data-wanderly-country-boundaries="true" aria-hidden="true" className="pointer-events-none absolute inset-0 z-[3] size-full overflow-hidden" viewBox={`0 0 ${map?.getContainer().clientWidth ?? 1} ${map?.getContainer().clientHeight ?? 1}`}>
      <g data-boundary-source="natural-earth">
        {paths.global.map((path, index) => <path key={`global-${index}`} d={path} fill="none" stroke="#073d50" strokeOpacity="0.92" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
      </g>
      <g data-boundary-source="datav-china">
        {paths.china.map((path, index) => <path key={`china-${index}`} d={path} fill="none" stroke="#073d50" strokeOpacity="1" strokeWidth="1.9" vectorEffect="non-scaling-stroke" />)}
      </g>
    </svg>
  );
}

async function fetchBoundaryCollection(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Country boundary data request failed (${response.status})`);
  const collection = await response.json() as GeoJSON.FeatureCollection;
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("Country boundary data is not a GeoJSON FeatureCollection");
  }
  return collection;
}
