"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useState } from "react";

import { COUNTRY_BOUNDARY_DATA_URL } from "./map-surface-style";

type Projector = (coordinates: [number, number]) => { x: number; y: number };

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
  const [data, setData] = useState<GeoJSON.FeatureCollection | null>(null);
  const [paths, setPaths] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void fetch(COUNTRY_BOUNDARY_DATA_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Country boundary data request failed (${response.status})`);
        return response.json() as Promise<GeoJSON.FeatureCollection>;
      })
      .then((collection) => {
        if (active && collection.type === "FeatureCollection" && Array.isArray(collection.features)) setData(collection);
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
        setPaths(projectCountryBoundaryPaths(
          data,
          (coordinates) => map.project(coordinates),
          container.clientWidth,
          (coordinates) => isCoordinateOnVisibleHemisphere(coordinates, [center.lng, center.lat]),
        ));
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

  if (!visible || paths.length === 0) return null;
  return (
    <svg data-wanderly-country-boundaries="true" aria-hidden="true" className="pointer-events-none absolute inset-0 z-[3] size-full overflow-hidden" viewBox={`0 0 ${map?.getContainer().clientWidth ?? 1} ${map?.getContainer().clientHeight ?? 1}`}>
      {paths.map((path, index) => <path key={index} d={path} fill="none" stroke="#073d50" strokeOpacity="0.92" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}
