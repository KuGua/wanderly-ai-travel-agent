/**
 * Controlled flight-search airport references. These identifiers are the only
 * locations accepted by the future Shared flight Tool; map/geocoding output is
 * deliberately not a source of flight-search facts.
 */
export interface AirportReference {
  id: string;
  iataCode: string;
  city: string;
  countryCode: string;
}

const AIRPORTS: readonly AirportReference[] = [
  { id: "SFO", iataCode: "SFO", city: "San Francisco", countryCode: "US" },
  { id: "PVG", iataCode: "PVG", city: "Shanghai", countryCode: "CN" },
  { id: "NRT", iataCode: "NRT", city: "Tokyo", countryCode: "JP" },
  { id: "SIN", iataCode: "SIN", city: "Singapore", countryCode: "SG" },
  { id: "LIS", iataCode: "LIS", city: "Lisbon", countryCode: "PT" },
];

const byId = new Map(AIRPORTS.map((airport) => [airport.id, airport]));

export function resolveAirportReference(id: string): AirportReference | null {
  return byId.get(id) ?? null;
}

export function isControlledIata(value: string): boolean {
  return /^[A-Z]{3}$/.test(value) && [...byId.values()].some((airport) => airport.iataCode === value);
}
