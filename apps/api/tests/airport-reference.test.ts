import { describe, expect, it } from "vitest";

import {
  airportIdsForCities,
  airportServesCity,
  controlledAirports,
  isControlledIata,
  resolveAirportReference,
} from "../src/location-reference/airport-reference.js";

describe("the controlled airport reference", () => {
  it("has no duplicate ids", () => {
    const ids = controlledAirports().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries a well-formed IATA code matching its id", () => {
    for (const airport of controlledAirports()) {
      expect(airport.iataCode).toMatch(/^[A-Z]{3}$/);
      expect(airport.id).toBe(airport.iataCode);
      expect(airport.countryCode).toMatch(/^[A-Z]{2}$/);
      expect(airport.city.trim()).not.toBe("");
    }
  });

  it("resolves a city stored in Chinese, which a confirmed brief often is", () => {
    // Real snapshots hold "Tokyo" and "东京" side by side. Matching the
    // canonical English spelling alone missed airports already in the table,
    // so flights were unavailable for a trip whose brief happened to be
    // written in Chinese.
    expect(airportIdsForCities(["东京"])).toEqual(airportIdsForCities(["Tokyo"]));
    expect(airportIdsForCities(["大阪"])).toEqual(airportIdsForCities(["Osaka"]));
    expect(airportIdsForCities(["福冈"])).toEqual(["FUK"]);
    expect(airportIdsForCities(["上海"])).toEqual(["PVG", "SHA"]);
  });

  it("returns every airport serving a city, primary gateway first", () => {
    expect(airportIdsForCities(["Tokyo"])).toEqual(["NRT", "HND"]);
    expect(airportIdsForCities(["London"])).toEqual(["LHR", "LGW", "STN"]);
  });

  it("keeps the order the cities were given and never repeats an id", () => {
    expect(airportIdsForCities(["Singapore", "Tokyo", "东京"])).toEqual(["SIN", "NRT", "HND"]);
  });

  it("ignores case, spacing, punctuation and diacritics", () => {
    expect(airportIdsForCities(["  hong kong "])).toEqual(["HKG"]);
    expect(airportIdsForCities(["Xi'an"])).toEqual(airportIdsForCities(["xian"]));
    expect(airportIdsForCities(["São Paulo"])).toEqual(["GRU"]);
    expect(airportIdsForCities(["sao paulo"])).toEqual(["GRU"]);
  });

  it("contributes nothing for a city it does not serve", () => {
    // A gap must stay a gap: guessing a nearby code is what the controlled
    // list exists to prevent.
    expect(airportIdsForCities(["Kyoto", "扬州"])).toEqual([]);
  });

  it("matches a snapshot candidate written in either language", () => {
    const nrt = resolveAirportReference("NRT")!;
    expect(airportServesCity(nrt, "东京")).toBe(true);
    expect(airportServesCity(nrt, "Tokyo")).toBe(true);
    expect(airportServesCity(nrt, "Osaka")).toBe(false);
  });

  it("accepts only ids that are in the table", () => {
    expect(isControlledIata("NRT")).toBe(true);
    expect(isControlledIata("ZZZ")).toBe(false);
    expect(isControlledIata("nrt")).toBe(false);
    expect(resolveAirportReference("NRT")?.city).toBe("Tokyo");
    expect(resolveAirportReference("ZZZ")).toBeNull();
  });

  it("covers enough of the world to be usable", () => {
    // It began as a five-entry demo fixture, which made flight search dead
    // for nearly every trip.
    expect(controlledAirports().length).toBeGreaterThan(150);
    expect(new Set(controlledAirports().map((a) => a.countryCode)).size).toBeGreaterThan(40);
  });
});
