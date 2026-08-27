import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// Builds the versioned country reference geometry used by the server-side
// location reference resolver. The source is the same Natural Earth 1:10m
// Admin 0 release the web boundary meshes are generated from, so the country
// a click resolves to always matches the border the map draws. The 1:110m
// release omits micro states entirely (Singapore, Malta, Monaco, Bahrain,
// Hong Kong, Macao), which made clicks inside Singapore resolve to Malaysia.

const naturalEarthVersion = "v5.1.2";
const naturalEarthUrl = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${naturalEarthVersion}/geojson/ne_10m_admin_0_countries.geojson`;
const dataDirectory = resolve(import.meta.dirname, "../data/location-reference");
const outputPath = resolve(dataDirectory, "countries.geojson");
const manifestPath = resolve(dataDirectory, "source-manifest.json");
const inputPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : null;

const source = inputPath ? await readFile(inputPath) : await downloadNaturalEarth();
const countries = JSON.parse(source.toString("utf8"));
if (countries.type !== "FeatureCollection") {
  throw new Error("Natural Earth Admin 0 input must be a GeoJSON FeatureCollection.");
}

const features = countries.features.map((feature) => ({
  type: "Feature",
  bbox: feature.bbox ?? boundingBox(feature.geometry),
  properties: {
    ADMIN: feature.properties.ADMIN ?? null,
    // Natural Earth 10m stores "-99" for disputed or de-facto entries and for
    // sovereign states whose code lives in ISO_A2_EH (France, Norway). Without
    // this fallback the resolver loses their province and nearest city lookup.
    ISO_A2: isoAlpha2(feature.properties.ISO_A2) ?? isoAlpha2(feature.properties.ISO_A2_EH),
    ADM0_A3: feature.properties.ADM0_A3 ?? null,
    NAME_EN: feature.properties.NAME_EN ?? feature.properties.NAME ?? null,
    NAME_ZH: feature.properties.NAME_ZH ?? null,
    LABEL_X: feature.properties.LABEL_X ?? null,
    LABEL_Y: feature.properties.LABEL_Y ?? null,
    LABELRANK: feature.properties.LABELRANK ?? null,
  },
  geometry: feature.geometry,
}));

const collection = {
  type: "FeatureCollection",
  metadata: {
    source: "Natural Earth 1:10m Admin 0 Countries",
    version: naturalEarthVersion,
    url: naturalEarthUrl,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    note: "Country-level point-in-polygon reference and country label anchors only; never an address, boundary claim or travel fact.",
  },
  features,
};

const serialized = `${JSON.stringify(collection)}\n`;
await writeFile(outputPath, serialized);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.countryBoundaries = {
  ...manifest.countryBoundaries,
  source: `Natural Earth 1:10m Admin 0 Countries ${naturalEarthVersion}`,
  path: "countries.geojson",
  license: "Public domain",
  sha256: createHash("sha256").update(serialized).digest("hex"),
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote ${features.length} country reference features (${serialized.length} bytes) from Natural Earth ${naturalEarthVersion}.`);

function isoAlpha2(value) {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value) ? value : null;
}

function boundingBox(geometry) {
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
  return [minLongitude, minLatitude, maxLongitude, maxLatitude];
}

async function downloadNaturalEarth() {
  const response = await fetch(naturalEarthUrl);
  if (!response.ok) throw new Error(`Natural Earth download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
