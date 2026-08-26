import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";

import { mesh } from "topojson-client";
import { topology } from "topojson-server";
import { presimplify, quantile, simplify } from "topojson-simplify";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "public/map-data");
const naturalEarthVersion = "v5.1.2";
const naturalEarthUrl = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${naturalEarthVersion}/geojson/ne_10m_admin_0_countries.geojson`;
const inputPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : null;

// LOD-0 only has to survive the whole-globe view, where 0.5% of the source
// points is indistinguishable from more. LOD-1 takes over at zoom 2 — by then
// the camera frames a subcontinent and the coarse mesh would read as blocky —
// and stays on as the stand-in until the full-fidelity tiles arrive.
const lods = [
  { id: "lod0", simplificationQuantile: 0.005, minZoom: 0, maxZoom: 2 },
  { id: "lod1", simplificationQuantile: 0.035, minZoom: 2, maxZoom: null },
];
// A single global simplification threshold erases whole micro states: every
// point of Singapore's ring weighs less than the world-wide quantile, so the
// mesh kept only a degenerate stub and no Singapore outline was drawn. Every
// arc of a country whose full geometry spans less than this many degrees is
// pinned so simplification keeps it at all LODs.
const smallCountrySpanDegrees = 1.5;
// LOD-3 carries the source geometry unsimplified so borders stay crisp when the
// camera is close. A single global file would be 8.5 MB gzipped, so it ships as
// 20° tiles the overlay fetches by viewport instead.
const tiledLod = {
  id: "lod3",
  minZoom: 4.5,
  tileSizeDegrees: 20,
  // ~40 m grid, so the fidelity ceiling is Natural Earth 10m itself rather than
  // the 400 m grid the simplified LODs quantize to.
  quantization: 1_000_000,
  // ~11 m of coordinate precision: far below the source's own accuracy.
  coordinateDecimals: 4,
  // Long arcs are cut into runs so a tile holds only nearby geometry and the
  // overlay's per-line bbox culling stays fine-grained.
  maxPointsPerRun: 128,
  directory: "country-borders-lod3",
};

const source = inputPath
  ? await readFile(inputPath)
  : await downloadNaturalEarth();
const countries = JSON.parse(source.toString("utf8"));
if (countries.type !== "FeatureCollection") {
  throw new Error("Natural Earth Admin 0 input must be a GeoJSON FeatureCollection.");
}

const sourceSha256 = createHash("sha256").update(source).digest("hex");
const baseTopology = presimplify(topology({ countries }, 100_000));
// Thresholds come from the untouched weight distribution, then the micro-state
// arcs are pinned so no LOD can drop them.
const thresholdByLod = new Map(lods.map((lod) => [lod.id, quantile(baseTopology, lod.simplificationQuantile)]));
const pinnedArcCount = pinSmallCountryArcs(baseTopology, countries, smallCountrySpanDegrees);
const manifest = {
  schemaVersion: 1,
  generatedAt: process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString() : null,
  smallCountrySpanDegrees,
  pinnedArcCount,
  sources: [{
    name: "Natural Earth Admin 0 Countries",
    version: naturalEarthVersion,
    url: naturalEarthUrl,
    sha256: sourceSha256,
    usage: "Build-time source only; browsers load the derived local line meshes.",
  }],
  datasets: [],
};

await mkdir(outputDirectory, { recursive: true });
for (const lod of lods) {
  const threshold = thresholdByLod.get(lod.id);
  const simplified = simplify(structuredClone(baseTopology), threshold);
  const borderMesh = mesh(simplified, simplified.objects.countries);
  const output = {
    type: "FeatureCollection",
    metadata: {
      source: "Natural Earth Admin 0 Countries",
      version: naturalEarthVersion,
      lod: lod.id,
      minZoom: lod.minZoom,
      maxZoom: lod.maxZoom,
      smallCountrySpanDegrees,
      topology: "shared arcs; every country border or coastline segment is emitted once",
    },
    features: [{ type: "Feature", properties: { class: "country-boundary" }, geometry: borderMesh }],
  };
  const serialized = `${JSON.stringify(output)}\n`;
  const outputPath = resolve(outputDirectory, `country-borders-${lod.id}.geojson`);
  await writeFile(outputPath, serialized);
  manifest.datasets.push({
    id: lod.id,
    path: `map-data/country-borders-${lod.id}.geojson`,
    minZoom: lod.minZoom,
    maxZoom: lod.maxZoom,
    simplificationQuantile: lod.simplificationQuantile,
    bytes: Buffer.byteLength(serialized),
    gzipBytes: gzipSync(serialized).byteLength,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  });
}

await writeTiledLod();

await writeFile(resolve(outputDirectory, "boundary-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${manifest.datasets.length} shared-boundary datasets from Natural Earth ${naturalEarthVersion}.`);

async function writeTiledLod() {
  const fullTopology = topology({ countries }, tiledLod.quantization);
  const borderMesh = mesh(fullTopology, fullTopology.objects.countries);
  const runs = borderMesh.coordinates.flatMap((line) => splitIntoRuns(line, tiledLod.maxPointsPerRun))
    .map((run) => run.map(([longitude, latitude]) => [
      roundCoordinate(longitude, tiledLod.coordinateDecimals),
      roundCoordinate(latitude, tiledLod.coordinateDecimals),
    ]));

  const runsByTile = new Map();
  for (const run of runs) {
    for (const key of tileKeysForRun(run, tiledLod.tileSizeDegrees)) {
      const grouped = runsByTile.get(key) ?? [];
      grouped.push(run);
      runsByTile.set(key, grouped);
    }
  }

  const tileDirectory = resolve(outputDirectory, tiledLod.directory);
  await mkdir(tileDirectory, { recursive: true });
  const tiles = [];
  for (const key of [...runsByTile.keys()].sort()) {
    const output = {
      type: "FeatureCollection",
      metadata: {
        source: "Natural Earth Admin 0 Countries",
        version: naturalEarthVersion,
        lod: tiledLod.id,
        tile: key,
        tileSizeDegrees: tiledLod.tileSizeDegrees,
        topology: "shared arcs at source fidelity; runs are duplicated into every tile they touch",
      },
      features: [{
        type: "Feature",
        properties: { class: "country-boundary" },
        geometry: { type: "MultiLineString", coordinates: runsByTile.get(key) },
      }],
    };
    const serialized = `${JSON.stringify(output)}\n`;
    await writeFile(resolve(tileDirectory, `${key}.geojson`), serialized);
    tiles.push({
      key,
      bytes: Buffer.byteLength(serialized),
      gzipBytes: gzipSync(serialized).byteLength,
      sha256: createHash("sha256").update(serialized).digest("hex"),
    });
  }

  const index = {
    schemaVersion: 1,
    lod: tiledLod.id,
    minZoom: tiledLod.minZoom,
    tileSizeDegrees: tiledLod.tileSizeDegrees,
    source: "Natural Earth Admin 0 Countries",
    version: naturalEarthVersion,
    tiles,
  };
  const serializedIndex = `${JSON.stringify(index, null, 2)}\n`;
  await writeFile(resolve(tileDirectory, "index.json"), serializedIndex);
  manifest.datasets.push({
    id: tiledLod.id,
    indexPath: `map-data/${tiledLod.directory}/index.json`,
    pathTemplate: `map-data/${tiledLod.directory}/{tile}.geojson`,
    minZoom: tiledLod.minZoom,
    maxZoom: null,
    tileSizeDegrees: tiledLod.tileSizeDegrees,
    quantization: tiledLod.quantization,
    coordinateDecimals: tiledLod.coordinateDecimals,
    maxPointsPerRun: tiledLod.maxPointsPerRun,
    tileCount: tiles.length,
    totalBytes: tiles.reduce((total, tile) => total + tile.bytes, 0),
    totalGzipBytes: tiles.reduce((total, tile) => total + tile.gzipBytes, 0),
    largestTileGzipBytes: Math.max(...tiles.map((tile) => tile.gzipBytes)),
    indexSha256: createHash("sha256").update(serializedIndex).digest("hex"),
  });
}

function splitIntoRuns(line, maxPoints) {
  if (line.length <= maxPoints) return [line];
  const runs = [];
  // Runs overlap by one point so the drawn path has no gap at the seam.
  for (let start = 0; start < line.length - 1; start += maxPoints - 1) {
    runs.push(line.slice(start, Math.min(line.length, start + maxPoints)));
  }
  return runs;
}

function roundCoordinate(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function tileKeysForRun(run, tileSizeDegrees) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of run) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  const keys = [];
  for (let x = tileOrigin(west, tileSizeDegrees); x <= tileOrigin(east, tileSizeDegrees); x += tileSizeDegrees) {
    for (let y = tileOrigin(south, tileSizeDegrees); y <= tileOrigin(north, tileSizeDegrees); y += tileSizeDegrees) {
      keys.push(`${x}_${y}`);
    }
  }
  return keys;
}

function tileOrigin(value, tileSizeDegrees) {
  return Math.floor(value / tileSizeDegrees) * tileSizeDegrees;
}

function pinSmallCountryArcs(topo, source, maxSpanDegrees) {
  const smallCountries = new Set(source.features
    .filter((feature) => geometrySpanDegrees(feature.geometry) < maxSpanDegrees)
    .map((feature) => feature.properties.ADM0_A3));
  const pinned = new Set();
  for (const geometry of topo.objects.countries.geometries) {
    if (!smallCountries.has(geometry.properties.ADM0_A3)) continue;
    collectArcIndices(geometry.arcs, pinned);
  }
  for (const index of pinned) {
    for (const point of topo.arcs[index]) point[2] = Infinity;
  }
  return pinned.size;
}

function collectArcIndices(arcs, collected) {
  for (const arc of arcs) {
    if (typeof arc === "number") collected.add(arc < 0 ? ~arc : arc);
    else collectArcIndices(arc, collected);
  }
}

function geometrySpanDegrees(geometry) {
  let minLongitude = Infinity;
  let minLatitude = Infinity;
  let maxLongitude = -Infinity;
  let maxLatitude = -Infinity;
  const visit = (coordinates) => {
    if (typeof coordinates[0] === "number") {
      minLongitude = Math.min(minLongitude, coordinates[0]);
      maxLongitude = Math.max(maxLongitude, coordinates[0]);
      minLatitude = Math.min(minLatitude, coordinates[1]);
      maxLatitude = Math.max(maxLatitude, coordinates[1]);
      return;
    }
    coordinates.forEach(visit);
  };
  visit(geometry.coordinates);
  return Math.max(maxLongitude - minLongitude, maxLatitude - minLatitude);
}

async function downloadNaturalEarth() {
  const response = await fetch(naturalEarthUrl);
  if (!response.ok) throw new Error(`Natural Earth download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
