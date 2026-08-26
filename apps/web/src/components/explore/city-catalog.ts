import { GEOGRAPHY_LABEL_DATA_URL } from "./geography-label-overlay";

export type CatalogCity = {
  key: string;
  name: string;
  localizedName: string;
  coordinates: [number, number];
  aliases: string[];
};

type PlaceFeature = GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>;

let cityCatalogPromise: Promise<CatalogCity[]> | null = null;

export function loadCityCatalog(locale: string): Promise<CatalogCity[]> {
  if (!cityCatalogPromise) {
    cityCatalogPromise = fetch(GEOGRAPHY_LABEL_DATA_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(`City catalog request failed (${response.status})`);
        return response.json() as Promise<GeoJSON.FeatureCollection<GeoJSON.Point, Record<string, unknown>>>;
      })
      .then((collection) => cityCatalogFromFeatures(collection.features, locale))
      .catch(() => []);
  }
  return cityCatalogPromise.then((cities) => localizeCatalog(cities, locale));
}

export function cityCatalogFromFeatures(features: PlaceFeature[], locale: string): CatalogCity[] {
  return features.flatMap((feature) => {
    const properties = feature.properties;
    const className = text(properties.class)?.toLowerCase();
    if (className !== "city" && className !== "capital") return [];
    const coordinates = feature.geometry.coordinates;
    if (!Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) return [];
    const englishName = text(properties.name_en) ?? text(properties["name:en"]) ?? text(properties.name);
    if (!englishName) return [];
    const aliases = unique([
      englishName,
      text(properties.name),
      text(properties.name_en),
      text(properties["name:en"]),
      text(properties.name_zh),
      text(properties["name:zh"]),
      text(properties["name:zh-Hans"]),
    ]);
    return [{
      key: `city:${normalize(englishName)}:${coordinates[0].toFixed(4)}:${coordinates[1].toFixed(4)}`,
      name: englishName,
      localizedName: localizedText(properties, locale) ?? englishName,
      coordinates: [coordinates[0], coordinates[1]] as [number, number],
      aliases,
    }];
  });
}

export function findMentionedCity(textValue: string, cities: CatalogCity[]): CatalogCity | null {
  return findMentionedCities(textValue, cities)[0] ?? null;
}

export function findMentionedCities(textValue: string, cities: CatalogCity[]): CatalogCity[] {
  const textToSearch = textValue.normalize("NFKC");
  const matches = cities.flatMap((city) => city.aliases.flatMap((alias) => {
    const index = aliasMatchIndex(textToSearch, alias);
    return index < 0 ? [] : [{ city, index, aliasLength: alias.length }];
  }));
  matches.sort((left, right) => left.index - right.index || right.aliasLength - left.aliasLength);
  const uniqueCities = new Map<string, CatalogCity>();
  matches.forEach(({ city }) => {
    if (!uniqueCities.has(city.key)) uniqueCities.set(city.key, city);
  });
  return [...uniqueCities.values()];
}

export function cityKey(countryCode: string | null, name: string) {
  return `city:${countryCode?.toUpperCase() ?? "unknown"}:${normalize(name)}`;
}

function localizeCatalog(cities: CatalogCity[], locale: string): CatalogCity[] {
  if (!locale.toLowerCase().startsWith("zh")) return cities.map((city) => ({ ...city, localizedName: city.name }));
  return cities.map((city) => ({
    ...city,
    localizedName: city.aliases.find((alias) => /[\u3400-\u9fff]/u.test(alias)) ?? city.name,
  }));
}

function localizedText(properties: Record<string, unknown>, locale: string) {
  const keys = locale.toLowerCase().startsWith("zh")
    ? ["name:zh-Hans", "name:zh", "name_zh", "name:en", "name_en", "name"]
    : ["name:en", "name_en", "name"];
  return keys.map((key) => text(properties[key])).find(Boolean) ?? null;
}

function aliasMatchIndex(textValue: string, aliasValue: string) {
  const normalizedSource = textValue.normalize("NFKC");
  const normalizedAlias = aliasValue.normalize("NFKC");
  const source = normalizedSource.toLocaleLowerCase();
  const alias = normalizedAlias.toLocaleLowerCase();
  if ([...alias].length < 2) return -1;
  let index = source.indexOf(alias);
  while (index >= 0) {
    const hasLatinLetters = /\p{Script=Latin}/u.test(normalizedAlias);
    const preservesPlaceCapitalization = normalizedSource.slice(index, index + normalizedAlias.length) === normalizedAlias;
    if ((!hasLatinLetters || preservesPlaceCapitalization)
      && (!hasLatinLetters || hasWordEdges(source, index, alias.length))) return index;
    index = source.indexOf(alias, index + 1);
  }
  return -1;
}

function hasWordEdges(source: string, index: number, length: number) {
  const before = index === 0 ? "" : source[index - 1];
  const after = index + length >= source.length ? "" : source[index + length];
  const word = /[\p{L}\p{N}]/u;
  return (!before || !word.test(before)) && (!after || !word.test(after));
}

function normalize(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unique(values: Array<string | null>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
