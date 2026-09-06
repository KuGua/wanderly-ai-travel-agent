import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  PLACE_MUTATION_ACTION_BY_TOOL,
  buildPlanningToolDefinitions,
} from "../src/services/planning-service.js";
import { flightSearchModelArgumentsSchema } from "../src/services/flight-search-service.js";
import { activitiesSearchModelArgumentsSchema } from "../src/services/activities-search-service.js";
import { placeSearchModelArgumentsSchema } from "../src/services/place-search-service.js";
import { navigationRouteModelArgumentsSchema } from "../src/services/navigation-route-service.js";
import { hotelSearchModelArgumentsSchema } from "../src/services/hotel-search-service.js";
import { accommodationDiscoveryModelArgumentsSchema } from "../src/services/accommodation-discovery-service.js";
import { tripPlaceModelArgumentsSchema } from "../src/skills/shared/trip-place-skill.js";

/**
 * The advertised parameter schema and the schema that actually validates the
 * call must describe the same thing.
 *
 * On 2026-09-06 they did not. `places.adopt` told the model to send
 * `{ action, candidateId, placeId }` while the server validated a
 * discriminated union whose branches additionally require `visibility` +
 * `kind` (propose) and `reason` (revoke) — so all three actions were
 * uncallable. The model spent a whole run's turn budget discovering that one
 * rejection at a time, the run produced no plan, and because a `ZodError` is
 * not a `SkillError` every rejection was filed as `UPSTREAM_FAILURE` and shown
 * to the traveller as "the provider was temporarily unavailable" — for calls
 * no provider ever saw.
 *
 * Nothing else held the two descriptions against each other: the tool-list
 * test uses `parameters: {}` stubs. This file is that missing test.
 */

/** Everything on, so the catalog holds every tool that can ever be offered. */
const ALL_TOOLS = buildPlanningToolDefinitions({
  originAirports: ["SIN"],
  destinationAirports: ["PVG"],
  // The typographic apostrophe on purpose: this is what the place resolver
  // writes, and it is the exact value every destination-taking tool has to
  // put in front of the model.
  destinationCandidates: ["Xi\u2019an"],
  activitiesEnabled: true,
  placesEnabled: true,
  navigationEnabled: true,
  hotelEnabled: true,
  accommodationDiscoveryEnabled: true,
});

const toolByName = (name: string) => {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool ${name} is not in the catalog`);
  return tool;
};

interface AdvertisedSchema {
  type: string;
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, { type?: string; enum?: string[]; format?: string }>;
}

const advertised = (name: string): AdvertisedSchema => toolByName(name).parameters as unknown as AdvertisedSchema;

/**
 * The tools whose arguments the dispatcher validates directly. The three
 * place-mutation tools are checked separately: the dispatcher adds `action`
 * before validating, so their advertised schema is deliberately one field
 * short of the union branch it parses through.
 */
const DIRECTLY_VALIDATED: ReadonlyArray<[string, z.ZodType]> = [
  ["flight.search", flightSearchModelArgumentsSchema],
  ["activities.search", activitiesSearchModelArgumentsSchema],
  ["places.search", placeSearchModelArgumentsSchema],
  ["navigation.route", navigationRouteModelArgumentsSchema],
  ["hotel.search", hotelSearchModelArgumentsSchema],
  ["accommodation.discover", accommodationDiscoveryModelArgumentsSchema],
];

/** The keys a Zod object (possibly wrapped in effects) declares. */
function zodShapeOf(schema: z.ZodType): Record<string, z.ZodType> {
  const definition = schema as unknown as { def?: { type?: string; shape?: Record<string, z.ZodType>; innerType?: z.ZodType } };
  if (definition.def?.shape) return definition.def.shape;
  if (definition.def?.innerType) return zodShapeOf(definition.def.innerType);
  throw new Error("schema is not an object schema");
}

function isOptional(schema: z.ZodType): boolean {
  return schema.safeParse(undefined).success;
}

describe("planning tool contract", () => {
  describe.each(DIRECTLY_VALIDATED)("%s", (name, schema) => {
    it("advertises every field its validator requires", () => {
      const shape = zodShapeOf(schema);
      const requiredByValidator = Object.entries(shape)
        .filter(([, field]) => !isOptional(field))
        .map(([key]) => key)
        .sort();
      expect([...advertised(name).required].sort()).toEqual(requiredByValidator);
    });

    it("advertises no field its validator would refuse", () => {
      // Every schema is `.strict()`, so an advertised key the validator does
      // not know is a key the model will be told to send and then rejected for.
      const known = new Set(Object.keys(zodShapeOf(schema)));
      for (const key of Object.keys(advertised(name).properties)) {
        expect(known.has(key), `${name} advertises unknown property ${key}`).toBe(true);
      }
    });
  });

  /**
   * A uuid advertised as a bare string is a contract the model cannot honour
   * from what it has been shown. `navigation.route` used to advertise its
   * place ids that way; the model supplied a plausible-looking non-uuid and
   * the rejection was reported as a provider outage.
   */
  it.each([
    ["places.propose", "candidateId"],
    ["places.adopt", "placeId"],
    ["places.revoke", "placeId"],
    ["navigation.route", "originPlaceId"],
    ["navigation.route", "destinationPlaceId"],
  ])("%s declares %s as a uuid", (name, property) => {
    expect(advertised(name).properties[property]?.format).toBe("uuid");
  });

  describe("place mutation tools", () => {
    const ACCEPTED: Record<string, Record<string, unknown>> = {
      "places.propose": { candidateId: "11111111-1111-4111-8111-111111111111", visibility: "TEAM_VISIBLE", kind: "ATTRACTION" },
      "places.adopt": { placeId: "22222222-2222-4222-8222-222222222222" },
      "places.revoke": { placeId: "22222222-2222-4222-8222-222222222222", reason: "duplicate" },
    };

    it.each(Object.keys(ACCEPTED))("%s: arguments matching its advertised schema are accepted", (name) => {
      const action = PLACE_MUTATION_ACTION_BY_TOOL[name];
      const parsed = tripPlaceModelArgumentsSchema.safeParse({ ...ACCEPTED[name], action });
      expect(parsed.success, `${name} arguments were refused: ${JSON.stringify((parsed as { error?: unknown }).error)}`).toBe(true);
    });

    it.each(Object.keys(ACCEPTED))("%s advertises exactly the fields it validates", (name) => {
      const branch = zodShapeOf(
        (tripPlaceModelArgumentsSchema as unknown as { def: { options: z.ZodType[] } }).def.options
          .find((option) => {
            const shape = zodShapeOf(option);
            return shape.action?.safeParse(PLACE_MUTATION_ACTION_BY_TOOL[name]).success === true;
          })!,
      );
      // `action` is supplied by the dispatcher, never by the model.
      const validated = Object.keys(branch).filter((key) => key !== "action").sort();
      expect(Object.keys(advertised(name).properties).sort()).toEqual(validated);
      expect([...advertised(name).required].sort()).toEqual(validated);
    });

    it("never asks the model for an action", () => {
      for (const name of Object.keys(ACCEPTED)) {
        expect(Object.keys(advertised(name).properties)).not.toContain("action");
      }
    });
  });

  describe("availability", () => {
    /**
     * A `candidateId` exists only inside the run that searched for it, so the
     * mutation tools are unanswerable without `places.search`. Offering them
     * anyway is what put `places.adopt` in front of a model that had no
     * candidate to name.
     */
    it("offers no place mutation tool when places search is off", () => {
      const names = buildPlanningToolDefinitions({
        originAirports: ["SIN"], destinationAirports: ["PVG"],
        destinationCandidates: ["Shanghai"],
        activitiesEnabled: false, placesEnabled: false, navigationEnabled: true,
        hotelEnabled: false, accommodationDiscoveryEnabled: false,
      }).map((tool) => tool.name);
      expect(names).not.toContain("places.propose");
      expect(names).not.toContain("places.adopt");
      expect(names).not.toContain("places.revoke");
      // A route joins two adopted places, so it goes with them.
      expect(names).not.toContain("navigation.route");
    });

    it("offers the whole places family when places search is on", () => {
      const names = ALL_TOOLS.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([
        "places.search", "places.propose", "places.adopt", "places.revoke", "navigation.route",
      ]));
    });
  });
});

/**
 * Every destination-taking tool must name the candidates it will accept.
 *
 * `flight.search` always did; the other four said "one controlled destination"
 * and left the model to spell the city. A snapshot holding `Xi’an` (U+2019)
 * then met a model writing `Xi'an` (U+0027), and the tool was refused on every
 * turn until the run spent its whole budget and produced no plan.
 *
 * Named in the description rather than as a JSON-schema `enum` because the
 * provider's OpenAI-compatible endpoint answers 5xx to any request carrying
 * one — the same reason recorded on `flight.search`.
 */
describe("destination-taking tools advertise the candidates they accept", () => {
  for (const name of ["hotel.search", "accommodation.discover", "activities.search", "places.search"]) {
    it(`${name} names the snapshot's destinations verbatim`, () => {
      const description = toolByName(name).description;
      expect(description).toContain("destinationId must be one of:");
      expect(description).toContain("Xi\u2019an");
    });
  }

  it("flight.search keeps naming its airports", () => {
    expect(toolByName("flight.search").description).toContain("destinationId must be one of: PVG");
  });
});
