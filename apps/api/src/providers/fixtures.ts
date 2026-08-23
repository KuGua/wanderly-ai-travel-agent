import type { FlightOffer, StayOffer, GroundOffer, VisaChecklistItem } from "../types/domain.js";

const NOW = new Date().toISOString();

// ─── Demo Users ─────────────────────────────────────────────────────────────

export const DEMO_USERS = [
  { externalId: "alice", displayName: "Alice" },
  { externalId: "bob", displayName: "Bob" },
  { externalId: "chen", displayName: "Chen" },
];

// ─── Demo Profiles ──────────────────────────────────────────────────────────

export const DEMO_PROFILES = {
  alice: {
    nationality: "US",
    interests: ["art", "museums", "architecture"],
    accommodationStyle: "city_center" as const,
    noRedEye: true,
    departureCity: "San Francisco",
    availableDepartureDates: ["2025-08-01", "2025-08-15"],
    budgetMaxUsd: 5000,
  },
  bob: {
    nationality: "US",
    interests: ["food", "nightlife", "budget_travel"],
    accommodationStyle: "budget" as const,
    budgetMaxUsd: 2500,
    departureCity: "San Francisco",
    availableDepartureDates: ["2025-08-01", "2025-08-10"],
  },
  chen: {
    nationality: "CN",
    interests: ["history", "temples", "street_food"],
    accommodationStyle: "city_center" as const,
    departureCity: "Shanghai",
    availableDepartureDates: ["2025-08-05", "2025-08-20"],
    budgetMaxUsd: 3000,
  },
};

// ─── Demo Destinations ──────────────────────────────────────────────────────

export const DEMO_DESTINATIONS = [
  { city: "Tokyo", country: "Japan" },
  { city: "Bangkok", country: "Thailand" },
  { city: "Seoul", country: "South Korea" },
];

// ─── Flight Fixtures ────────────────────────────────────────────────────────

export const FLIGHT_FIXTURES: FlightOffer[] = [
  // SFO -> Tokyo
  { id: "flt-sfo-tyo-01", origin: "San Francisco", destination: "Tokyo", departureTime: "2025-08-01T11:00:00Z", arrivalTime: "2025-08-02T15:00:00Z", priceUsd: 850, isRedEye: false, airline: "Demo Air", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "flt-sfo-tyo-02", origin: "San Francisco", destination: "Tokyo", departureTime: "2025-08-01T23:30:00Z", arrivalTime: "2025-08-02T04:00:00Z", priceUsd: 680, isRedEye: true, airline: "Demo Air", source: "Demo data", capturedAt: NOW, isDemo: true },
  // SFO -> Bangkok
  { id: "flt-sfo-bkk-01", origin: "San Francisco", destination: "Bangkok", departureTime: "2025-08-01T10:00:00Z", arrivalTime: "2025-08-02T18:00:00Z", priceUsd: 720, isRedEye: false, airline: "Demo Air", source: "Demo data", capturedAt: NOW, isDemo: true },
  // SFO -> Seoul
  { id: "flt-sfo-icn-01", origin: "San Francisco", destination: "Seoul", departureTime: "2025-08-01T12:00:00Z", arrivalTime: "2025-08-02T17:00:00Z", priceUsd: 780, isRedEye: false, airline: "Demo Air", source: "Demo data", capturedAt: NOW, isDemo: true },
  // Shanghai -> Tokyo
  { id: "flt-sha-tyo-01", origin: "Shanghai", destination: "Tokyo", departureTime: "2025-08-05T09:00:00Z", arrivalTime: "2025-08-05T13:00:00Z", priceUsd: 350, isRedEye: false, airline: "Demo Air", source: "Demo data", capturedAt: NOW, isDemo: true },
  // Shanghai -> Bangkok
  { id: "flt-sha-bkk-01", origin: "Shanghai", destination: "Bangkok", departureTime: "2025-08-05T08:00:00Z", arrivalTime: "2025-08-05T12:00:00Z", priceUsd: 280, isRedEye: false, airline: "Demo Air", source: "Demo data", capturedAt: NOW, isDemo: true },
  // Shanghai -> Seoul
  { id: "flt-sha-icn-01", origin: "Shanghai", destination: "Seoul", departureTime: "2025-08-05T10:00:00Z", arrivalTime: "2025-08-05T13:00:00Z", priceUsd: 250, isRedEye: false, airline: "Demo Air", source: "Demo data", capturedAt: NOW, isDemo: true },
];

// ─── Stay Fixtures ──────────────────────────────────────────────────────────

export const STAY_FIXTURES: StayOffer[] = [
  { id: "stay-tyo-01", destination: "Tokyo", checkIn: "2025-08-02", checkOut: "2025-08-07", pricePerNightUsd: 180, style: "city_center", location: "Shinjuku", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "stay-tyo-02", destination: "Tokyo", checkIn: "2025-08-02", checkOut: "2025-08-07", pricePerNightUsd: 90, style: "budget", location: "Asakusa", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "stay-bkk-01", destination: "Bangkok", checkIn: "2025-08-02", checkOut: "2025-08-07", pricePerNightUsd: 120, style: "city_center", location: "Sukhumvit", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "stay-bkk-02", destination: "Bangkok", checkIn: "2025-08-02", checkOut: "2025-08-07", pricePerNightUsd: 45, style: "budget", location: "Khao San Road", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "stay-icn-01", destination: "Seoul", checkIn: "2025-08-02", checkOut: "2025-08-07", pricePerNightUsd: 150, style: "city_center", location: "Myeongdong", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "stay-icn-02", destination: "Seoul", checkIn: "2025-08-02", checkOut: "2025-08-07", pricePerNightUsd: 65, style: "budget", location: "Hongdae", source: "Demo data", capturedAt: NOW, isDemo: true },
];

// ─── Ground Transport Fixtures ──────────────────────────────────────────────

export const GROUND_FIXTURES: GroundOffer[] = [
  { id: "gnd-tyo-01", destination: "Tokyo", type: "airport_transfer", priceUsd: 35, provider: "Demo Transfer", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "gnd-tyo-02", destination: "Tokyo", type: "local_transport", priceUsd: 15, provider: "Demo Transit", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "gnd-bkk-01", destination: "Bangkok", type: "airport_transfer", priceUsd: 12, provider: "Demo Transfer", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "gnd-bkk-02", destination: "Bangkok", type: "local_transport", priceUsd: 5, provider: "Demo Transit", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "gnd-icn-01", destination: "Seoul", type: "airport_transfer", priceUsd: 25, provider: "Demo Transfer", source: "Demo data", capturedAt: NOW, isDemo: true },
  { id: "gnd-icn-02", destination: "Seoul", type: "local_transport", priceUsd: 10, provider: "Demo Transit", source: "Demo data", capturedAt: NOW, isDemo: true },
];

// ─── Visa Readiness Fixtures ────────────────────────────────────────────────

export const VISA_FIXTURES: Record<string, Record<string, { checklist: VisaChecklistItem[]; confidence: "HIGH" | "MEDIUM" | "LOW" | "UNCERTAIN"; source: string }>> = {
  "Japan": {
    "US": {
      checklist: [
        { item: "Valid passport (6+ months)", source: "Japan MOFA official", uncertainty: "Verify expiry date" },
        { item: "No visa required for short stay (90 days)", source: "Japan MOFA official", uncertainty: "Confirm purpose of visit" },
        { item: "Return ticket recommended", source: "Japan MOFA official", uncertainty: "Not legally required but may be requested" },
      ],
      confidence: "HIGH",
      source: "Japan Ministry of Foreign Affairs (demo fixture)",
    },
    "CN": {
      checklist: [
        { item: "Valid passport (6+ months)", source: "Japan MOFA official", uncertainty: "Verify expiry date" },
        { item: "Tourist visa required — apply at Japanese embassy/consulate", source: "Japan MOFA official", uncertainty: "Processing times vary; check official source" },
        { item: "Proof of accommodation and itinerary", source: "Japan MOFA official", uncertainty: "Requirements may change" },
        { item: "Financial proof (bank statements)", source: "Japan MOFA official", uncertainty: "Amount requirements vary" },
      ],
      confidence: "MEDIUM",
      source: "Japan Ministry of Foreign Affairs (demo fixture)",
    },
  },
  "Thailand": {
    "US": {
      checklist: [
        { item: "Valid passport (6+ months)", source: "Thai Immigration (demo fixture)", uncertainty: "Verify expiry" },
        { item: "Visa exemption for 30 days (air arrival)", source: "Thai Immigration (demo fixture)", uncertainty: "Policy subject to change" },
      ],
      confidence: "HIGH",
      source: "Thai Immigration Bureau (demo fixture)",
    },
    "CN": {
      checklist: [
        { item: "Valid passport (6+ months)", source: "Thai Immigration (demo fixture)", uncertainty: "Verify expiry" },
        { item: "Visa on arrival or e-visa may be available", source: "Thai Immigration (demo fixture)", uncertainty: "UNCERTAIN — verify with Royal Thai Embassy before travel" },
        { item: "Proof of onward travel may be required", source: "Thai Immigration (demo fixture)", uncertainty: "Enforcement varies" },
      ],
      confidence: "UNCERTAIN",
      source: "Thai Immigration Bureau (demo fixture — verify with official source)",
    },
  },
  "South Korea": {
    "US": {
      checklist: [
        { item: "Valid passport", source: "Korea Immigration (demo fixture)", uncertainty: "Check expiry" },
        { item: "K-ETA required for visa-free entry", source: "Korea Immigration (demo fixture)", uncertainty: "Apply online before travel" },
      ],
      confidence: "HIGH",
      source: "Korea Immigration Service (demo fixture)",
    },
    "CN": {
      checklist: [
        { item: "Valid passport", source: "Korea Immigration (demo fixture)", uncertainty: "Check expiry" },
        { item: "Visa required — apply at Korean embassy", source: "Korea Immigration (demo fixture)", uncertainty: "Processing times vary" },
        { item: "Invitation letter may be needed", source: "Korea Immigration (demo fixture)", uncertainty: "Depends on visa type" },
      ],
      confidence: "MEDIUM",
      source: "Korea Immigration Service (demo fixture)",
    },
  },
};

// ─── Change Event Fixtures ──────────────────────────────────────────────────

export const CHANGE_EVENT_FIXTURES = {
  priceIncrease: {
    eventType: "PRICE_CHANGE" as const,
    payload: { flightId: "flt-sfo-tyo-01", oldPrice: 850, newPrice: 1200 },
  },
  soldOut: {
    eventType: "INVENTORY_CHANGE" as const,
    payload: { flightId: "flt-sfo-tyo-01", status: "SOLD_OUT" },
  },
  departureRestriction: {
    eventType: "DEPARTURE_RESTRICTION" as const,
    payload: { userId: "chen", reason: "Schedule conflict — unavailable Aug 5" },
  },
};

// ─── Sandbox Callback Fixtures ──────────────────────────────────────────────

export const SANDBOX_CALLBACK_FIXTURES = {
  success: {
    serviceResults: {
      flight: { status: "SUCCESS" as const, reference: "DEMO-FLT-001" },
      hotel: { status: "SUCCESS" as const, reference: "DEMO-HTL-001" },
      ground: { status: "SUCCESS" as const, reference: "DEMO-GND-001" },
    },
  },
  partialFailure: {
    serviceResults: {
      flight: { status: "SUCCESS" as const, reference: "DEMO-FLT-002" },
      hotel: { status: "FAILED" as const, error: "No availability" },
      ground: { status: "SUCCESS" as const, reference: "DEMO-GND-002" },
    },
  },
};
