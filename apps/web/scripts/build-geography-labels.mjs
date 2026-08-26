import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SOURCES = {
  countries: "public/map-data/natural-earth-admin-0.geojson",
  places: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places.geojson",
  regions: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson",
  chinaRegions: "public/map-data/china-region-labels.geojson",
};

const [countries, places, regions, chinaRegions] = await Promise.all([
  JSON.parse(await readFile(resolve(root, SOURCES.countries), "utf8")),
  fetchJson(SOURCES.places),
  fetchJson(SOURCES.regions),
  JSON.parse(await readFile(resolve(root, SOURCES.chinaRegions), "utf8")),
]);

const features = [
  ...continentFeatures(),
  ...countries.features
    .filter(({ properties }) => properties.ADM0_A3 !== "TWN")
    .map(({ properties }) => pointFeature("country", properties.NAME_EN ?? properties.NAME, properties.NAME_ZH, properties.LABEL_X, properties.LABEL_Y, properties.LABELRANK)),
  ...places.features
    .filter(({ properties }) => properties.ADM0CAP === 1 || properties.WORLDCITY === 1 || properties.MEGACITY === 1 || properties.SCALERANK <= 4)
    .map(({ properties }) => pointFeature(properties.ADM0CAP === 1 ? "capital" : "city", properties.NAME_EN ?? properties.NAME, properties.NAME_ZH, properties.LONGITUDE, properties.LATITUDE, properties.SCALERANK)),
  ...regions.features
    .filter(({ properties }) => properties.scalerank <= 4 && properties.adm0_a3 !== "CHN" && properties.adm0_a3 !== "TWN")
    .map(({ properties }) => pointFeature("region", properties.name_en ?? properties.name, properties.name_zh, properties.longitude, properties.latitude, properties.scalerank)),
  ...chinaRegions.features
    .filter(({ properties, geometry }) => typeof properties.adcode === "number" && geometry?.type === "Point")
    .map(({ properties, geometry }) => pointFeature("region", chinaRegionEnglish(properties.adcode) ?? properties.name, properties.name, geometry.coordinates[0], geometry.coordinates[1], 1)),
].filter(Boolean);

const collection = {
  type: "FeatureCollection",
  metadata: {
    generatedAt: new Date().toISOString(),
    sources: SOURCES,
    note: "Display labels only; not a source for travel, legal, booking, visa or navigation facts.",
  },
  features,
};

await writeFile(resolve(root, "public/map-data/geography-labels.geojson"), `${JSON.stringify(collection)}\n`);
console.log(`Wrote ${features.length} geography labels.`);

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function pointFeature(className, nameEn, nameZh, longitude, latitude, rank) {
  if (typeof nameEn !== "string" || !nameEn || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return {
    type: "Feature",
    properties: { class: className, name: nameEn, name_en: nameEn, name_zh: typeof nameZh === "string" && nameZh ? nameZh : null, rank: Number.isFinite(rank) ? rank : 99 },
    geometry: { type: "Point", coordinates: [longitude, latitude] },
  };
}

function continentFeatures() {
  return [
    ["Africa", "非洲", 20, 2],
    ["Asia", "亚洲", 90, 47],
    ["Europe", "欧洲", 15, 53],
    ["North America", "北美洲", -105, 48],
    ["South America", "南美洲", -60, -17],
    ["Oceania", "大洋洲", 145, -23],
    ["Antarctica", "南极洲", 0, -82],
  ].map(([nameEn, nameZh, longitude, latitude]) => pointFeature("continent", nameEn, nameZh, longitude, latitude, 1));
}

function chinaRegionEnglish(adcode) {
  return {
    110000: "Beijing", 120000: "Tianjin", 130000: "Hebei", 140000: "Shanxi", 150000: "Inner Mongolia",
    210000: "Liaoning", 220000: "Jilin", 230000: "Heilongjiang", 310000: "Shanghai", 320000: "Jiangsu",
    330000: "Zhejiang", 340000: "Anhui", 350000: "Fujian", 360000: "Jiangxi", 370000: "Shandong",
    410000: "Henan", 420000: "Hubei", 430000: "Hunan", 440000: "Guangdong", 450000: "Guangxi",
    460000: "Hainan", 500000: "Chongqing", 510000: "Sichuan", 520000: "Guizhou", 530000: "Yunnan",
    540000: "Xizang", 610000: "Shaanxi", 620000: "Gansu", 630000: "Qinghai", 640000: "Ningxia",
    650000: "Xinjiang", 710000: "Taiwan", 810000: "Hong Kong", 820000: "Macao",
  }[adcode];
}
