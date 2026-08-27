export type GlobeCoordinate = [number, number];
export type ScreenPoint = { x: number; y: number };
export type ScreenRect = { left: number; right: number; top: number; bottom: number };

type GlobeProjector = {
  getCenter: () => { lng: number; lat: number };
  project: (coordinates: GlobeCoordinate) => ScreenPoint;
};

export type GlobeClip = { path: string; points: ScreenPoint[] };

const HORIZON_SAMPLE_COUNT = 48;

/**
 * Builds the projected horizon polygon for the camera-facing hemisphere.
 * SVG overlays do not participate in MapLibre's WebGL globe stencil, so they
 * must use this same silhouette to prevent labels and strokes escaping the
 * planet's edge.
 */
export function globeClipFrom(map: GlobeProjector, sampleCount = HORIZON_SAMPLE_COUNT): GlobeClip | null {
  const center = map.getCenter();
  if (!Number.isFinite(center.lng) || !Number.isFinite(center.lat) || sampleCount < 3) return null;

  const points: ScreenPoint[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const coordinate = destinationAtAngularDistance([center.lng, center.lat], (index / sampleCount) * 360, 90);
    const point = map.project(coordinate);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    points.push(point);
  }
  return {
    points,
    path: `M${points.map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" L")} Z`,
  };
}

export function screenRectIsInsideGlobe(rect: ScreenRect, clip: GlobeClip) {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom },
  ].every((point) => pointIsInPolygon(point, clip.points));
}

export function destinationAtAngularDistance([longitude, latitude]: GlobeCoordinate, bearingDegrees: number, distanceDegrees: number): GlobeCoordinate {
  const bearing = degreesToRadians(bearingDegrees);
  const distance = degreesToRadians(distanceDegrees);
  const startLatitude = degreesToRadians(latitude);
  const startLongitude = degreesToRadians(longitude);
  const destinationLatitude = Math.asin(
    Math.sin(startLatitude) * Math.cos(distance)
      + Math.cos(startLatitude) * Math.sin(distance) * Math.cos(bearing),
  );
  const destinationLongitude = startLongitude + Math.atan2(
    Math.sin(bearing) * Math.sin(distance) * Math.cos(startLatitude),
    Math.cos(distance) - Math.sin(startLatitude) * Math.sin(destinationLatitude),
  );
  return [normalizeLongitude(radiansToDegrees(destinationLongitude)), radiansToDegrees(destinationLatitude)];
}

function pointIsInPolygon(point: ScreenPoint, polygon: ScreenPoint[]) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const currentPoint = polygon[current];
    const previousPoint = polygon[previous];
    const intersects = (currentPoint.y > point.y) !== (previousPoint.y > point.y)
      && point.x < ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function degreesToRadians(value: number) {
  return value * Math.PI / 180;
}

function radiansToDegrees(value: number) {
  return value * 180 / Math.PI;
}

function normalizeLongitude(longitude: number) {
  return ((longitude + 540) % 360) - 180;
}
