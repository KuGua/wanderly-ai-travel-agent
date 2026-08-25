import type { ConversationPlace } from "../types/schemas.js";
import type { ConversationReply } from "../providers/model-gateway.js";

export const CONVERSATION_PLACE_FIXTURE_VERSION = "2026-08-25.v1";

interface ConversationPlaceFixture extends ConversationPlace {
  sourceType: "FIXTURE";
  fixtureVersion: string;
}

const CONVERSATION_PLACE_FIXTURES: Readonly<Record<string, ConversationPlaceFixture>> = {
  tokyo: {
    sourceId: "tokyo",
    name: "Tokyo",
    latitude: 35.6895,
    longitude: 139.6917,
    sourceType: "FIXTURE",
    fixtureVersion: CONVERSATION_PLACE_FIXTURE_VERSION,
  },
  lisbon: {
    sourceId: "lisbon",
    name: "Lisbon",
    latitude: 38.7223,
    longitude: -9.1393,
    sourceType: "FIXTURE",
    fixtureVersion: CONVERSATION_PLACE_FIXTURE_VERSION,
  },
  reykjavik: {
    sourceId: "reykjavik",
    name: "Reykjavík",
    latitude: 64.1466,
    longitude: -21.9426,
    sourceType: "FIXTURE",
    fixtureVersion: CONVERSATION_PLACE_FIXTURE_VERSION,
  },
};

const PRICE_TERMS = ["price", "prices", "cost", "costs", "fare", "fares", "rate", "rates"];
const LIVE_TERMS = ["current", "currently", "live", "real time", "today", "tonight", "now", "latest", "up to date"];
const TRAVEL_INVENTORY_TERMS = [
  "flight", "flights", "hotel", "hotels", "room", "rooms", "seat", "seats",
  "ticket", "tickets", "stay", "stays", "inventory",
];
const AVAILABILITY_TERMS = [
  "availability", "available", "unavailable", "sold out", "vacancy", "vacancies", "vacant", "left",
];
const BOOKING_STATUS_TERMS = [
  "availability", "available", "status", "confirmed", "confirmation", "pending", "cancelled", "canceled",
];
const FLIGHT_STATUS_TERMS = [
  "status", "delayed", "delay", "late", "cancelled", "canceled", "on time", "departure gate", "arrival gate",
];

export function resolveConversationPlace(place: ConversationPlace | undefined): ConversationPlace | undefined {
  if (!place) return undefined;

  const fixture = place.sourceType === "FIXTURE" && place.sourceId
    ? CONVERSATION_PLACE_FIXTURES[place.sourceId]
    : undefined;
  if (
    fixture
    && fixture.name === place.name
    && coordinatesMatch(fixture.latitude, place.latitude)
    && coordinatesMatch(fixture.longitude, place.longitude)
  ) {
    return {
      sourceId: fixture.sourceId,
      name: fixture.name,
      latitude: fixture.latitude,
      longitude: fixture.longitude,
      sourceType: "FIXTURE",
    };
  }

  return {
    ...place,
    sourceType: "INSPIRATION",
  };
}

export function requestsUnsupportedOperationalFacts(question: string): boolean {
  const text = normalizePolicyText(question);

  if (hasAnyTerm(text, ["visa", "visas"])) return true;
  if (
    hasAnyTerm(text, ["entry", "enter", "immigration", "passport"])
    && hasAnyTerm(text, [
      "rule", "rules", "require", "requires", "required", "requirement", "requirements",
      "need", "needs", "eligible", "eligibility", "valid", "allowed", "without",
    ])
  ) return true;

  if (
    hasAnyTerm(text, PRICE_TERMS)
    && (hasAnyTerm(text, [...LIVE_TERMS, ...TRAVEL_INVENTORY_TERMS]) || hasTerm(text, "how much"))
  ) return true;
  if (hasTerm(text, "how much") && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;
  if (hasTerm(text, "exchange rate") && hasAnyTerm(text, LIVE_TERMS)) return true;

  if (hasAnyTerm(text, AVAILABILITY_TERMS) && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;
  if (hasAnyTerm(text, ["are there", "is there"]) && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;

  if (
    hasAnyTerm(text, ["booking", "bookings", "reservation", "reservations"])
    && hasAnyTerm(text, BOOKING_STATUS_TERMS)
  ) return true;
  if (
    hasAnyTerm(text, ["book", "booking", "bookings", "reserve", "reservation", "reservations"])
    && hasAnyTerm(text, [...TRAVEL_INVENTORY_TERMS, "this", "it", "now"])
  ) return true;

  return hasFlightReference(text) && hasAnyTerm(text, FLIGHT_STATUS_TERMS);
}

export function containsUnsupportedOperationalClaim(content: string): boolean {
  const text = normalizePolicyText(content);

  // Chat has no authoritative visa provider path. Conservatively reject every
  // MODEL response that introduces visa facts, including unfamiliar phrasing.
  if (hasAnyTerm(text, ["visa", "visas"])) return true;
  if (
    hasAnyTerm(text, ["entry", "enter", "immigration", "passport"])
    && hasAnyTerm(text, [
      "require", "requires", "required", "requirement", "requirements", "need", "needs", "must",
      "eligible", "eligibility", "ineligible", "allowed", "not allowed", "valid", "invalid", "without",
    ])
  ) return true;

  if (
    hasAnyTerm(text, PRICE_TERMS)
    && (hasCurrencyValue(text) || hasNumericValue(text) || hasAnyTerm(text, [...LIVE_TERMS, "starts at", "from", "around", "approximately"]))
  ) return true;
  if (hasCurrencyValue(text) && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;

  if (hasAnyTerm(text, AVAILABILITY_TERMS) && hasAnyTerm(text, TRAVEL_INVENTORY_TERMS)) return true;
  if (
    hasAnyTerm(text, ["booking", "bookings", "reservation", "reservations"])
    && hasAnyTerm(text, BOOKING_STATUS_TERMS)
  ) return true;

  return hasFlightReference(text) && hasAnyTerm(text, FLIGHT_STATUS_TERMS);
}

export function safeConversationFallback(): ConversationReply {
  return {
    content:
      "I can help with general destination inspiration and qualitative comparisons, but this chat cannot verify current prices, inventory or availability, visa or entry requirements, booking status, flight status, or other real-time provider facts. Please check the relevant official provider or government source.",
    responseMode: "DEMO_FALLBACK",
  };
}

function coordinatesMatch(canonical: number, supplied: number): boolean {
  return Math.abs(canonical - supplied) <= 0.000001;
}

function normalizePolicyText(value: string): string {
  return value.normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$€£¥]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasTerm(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

function hasAnyTerm(text: string, terms: readonly string[]): boolean {
  return terms.some(term => hasTerm(text, term));
}

function hasCurrencyValue(text: string): boolean {
  return /(?:[$€£¥]\s?\d|\b\d[\d,.]*\s+(?:usd|eur|gbp|jpy|cny|sgd|dollars?|euros?|yen)\b)/i.test(text);
}

function hasNumericValue(text: string): boolean {
  return /\b\d[\d,.]*\b/.test(text);
}

function hasFlightReference(text: string): boolean {
  return hasAnyTerm(text, ["flight", "flights"])
    || /\b[a-z]{2,3}\s?\d{1,4}\b/i.test(text);
}
