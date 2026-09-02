/**
 * The tools a model is offered, and what happens when it calls one.
 *
 * The drift test is the one that matters most: the JSON Schema tells the
 * model what to send, the Zod draft decides what is accepted, and nothing
 * but a test keeps the two saying the same thing.
 */
import { describe, expect, it, vi } from "vitest";

import { PERSONAL_RESEARCH_TOOLS } from "../src/agents/personal-research-tools.js";
import { PERSONAL_RESEARCH_ALLOWED_CAPABILITIES } from "../src/config/personal-research-allowed-capabilities.js";
import { personalResearchOwnerDraftSchema } from "../src/types/schemas.js";

const DRAFT_KIND: Record<string, string> = {
  "places.search": "PLACES_SEARCH",
  "accommodation.discovery": "ACCOMMODATION_DISCOVERY",
  "activities.search": "ACTIVITIES_SEARCH",
  "navigation.route": "NAVIGATION_ROUTE",
  "flight.search": "FLIGHT_SEARCH",
};

/** A minimal valid argument object for each tool, per its own JSON Schema. */
const SAMPLE: Record<string, Record<string, unknown>> = {
  "places.search": { latitude: 35.68, longitude: 139.69, radiusMeters: 1500, category: null, keyword: null, limit: null },
  "accommodation.discovery": {
    latitude: 35.68, longitude: 139.69, radiusMeters: 2000,
    checkIn: "2026-10-01", checkOut: "2026-10-04", occupancy: { adults: 2, rooms: 1 },
  },
  "activities.search": { destinationCode: "Tokyo", startDate: "2026-10-01", endDate: "2026-10-05", category: null, limit: 10 },
  "navigation.route": {
    origin: { latitude: 34.9858, longitude: 135.7588, label: "京都站" },
    destination: { latitude: 34.9949, longitude: 135.7850, label: "清水寺" },
    mode: "walking",
  },
  "flight.search": {
    originId: "PVG", destinationId: "NRT", tripType: "ROUND_TRIP",
    departureDate: "2026-10-01", returnDate: "2026-10-08", adults: 1, cabin: "ECONOMY", currency: "USD",
  },
};

describe("offered tools", () => {
  it("offers only capabilities the allow-list has opened", () => {
    for (const tool of PERSONAL_RESEARCH_TOOLS) {
      expect(PERSONAL_RESEARCH_ALLOWED_CAPABILITIES as readonly string[]).toContain(tool.name);
    }
  });

  it("never asks the model for an id the server owns", () => {
    // A tripId the model can write is a tripId it can invent, and inventing
    // one means researching against somebody else's trip.
    for (const tool of PERSONAL_RESEARCH_TOOLS) {
      const properties = Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {});
      for (const owned of ["tripId", "threadId", "runId", "userId", "ownerUserId", "snapshotId"]) {
        expect(properties).not.toContain(owned);
      }
    }
  });

  it("closes every schema, so an invented field is rejected rather than ignored", () => {
    for (const tool of PERSONAL_RESEARCH_TOOLS) {
      expect((tool.parameters as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    }
  });

  it("gives each tool a description that says what it returns", () => {
    for (const tool of PERSONAL_RESEARCH_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});

describe("schema and draft agree", () => {
  it("accepts arguments shaped by the advertised schema", () => {
    // If a JSON Schema drifts from its draft, the model sends what it was
    // told and the draft rejects it — the call fails for a reason no one can
    // see from the model's side.
    for (const tool of PERSONAL_RESEARCH_TOOLS) {
      const parsed = personalResearchOwnerDraftSchema.safeParse({
        kind: DRAFT_KIND[tool.name],
        ...SAMPLE[tool.name],
      });
      expect(parsed.success, `${tool.name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  it("requires in the schema everything the draft requires", () => {
    for (const tool of PERSONAL_RESEARCH_TOOLS) {
      const required = (tool.parameters as { required?: string[] }).required ?? [];
      for (const field of required) {
        const without = { ...SAMPLE[tool.name] };
        delete without[field];
        const parsed = personalResearchOwnerDraftSchema.safeParse({ kind: DRAFT_KIND[tool.name], ...without });
        expect(parsed.success, `${tool.name}.${field} is advertised as required but the draft accepts it missing`).toBe(false);
      }
    }
  });
});

  it("advertises as required every field the draft insists on being present", () => {
    // `nullable()` is not `optional()`: the draft wants the key there with a
    // null value. A field left out of `required` gets omitted by the model
    // and the call is rejected for a reason it cannot see.
    for (const tool of PERSONAL_RESEARCH_TOOLS) {
      const properties = Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {});
      const required = (tool.parameters as { required?: string[] }).required ?? [];
      for (const field of properties) {
        if (required.includes(field)) continue;
        const without = { ...SAMPLE[tool.name] };
        delete without[field];
        const parsed = personalResearchOwnerDraftSchema.safeParse({ kind: DRAFT_KIND[tool.name], ...without });
        expect(parsed.success, `${tool.name}.${field} is advertised as optional but the draft rejects it missing`).toBe(true);
      }
    }
  });

describe("evidence signal", () => {
  const base = {
    ctx: { correlationId: "c" } as never,
    ownerUserId: "00000000-0000-0000-0000-000000000002",
    tripId: "00000000-0000-0000-0000-000000000003",
    threadId: "00000000-0000-0000-0000-000000000004",
    runId: "00000000-0000-0000-0000-000000000001",
    userConfirmed: false,
    signal: new AbortController().signal,
  };

  it("does not claim evidence for a call it refused before reaching a provider", async () => {
    // The flag is what lets the output filter admit prices. A refusal that
    // set it would license the model to state figures nothing produced.
    const { createPersonalResearchDispatcher } = await import("../src/agents/personal-research-tools.js");
    const dispatch = createPersonalResearchDispatcher(base);
    for (const call of [
      { id: "1", name: "mobility.search", arguments: {} },
      { id: "2", name: "places.search", arguments: { latitude: 999 } },
    ]) {
      const result = await dispatch(call) as { providerDispatched?: unknown };
      expect(result.providerDispatched).toBeUndefined();
    }
  });

  it("does not claim evidence for a search still waiting on the traveller", async () => {
    vi.resetModules();
    vi.doMock("../src/db/database.js", () => ({
      db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ userId: base.ownerUserId }] }) }) }) },
    }));
    const { createPersonalResearchDispatcher } = await import("../src/agents/personal-research-tools.js");
    const dispatch = createPersonalResearchDispatcher(base);
    const result = await dispatch({ id: "1", name: "flight.search", arguments: SAMPLE["flight.search"] }) as {
      outcome: string; providerDispatched?: unknown;
    };
    expect(result.outcome).toBe("NEEDS_CONFIRMATION");
    expect(result.providerDispatched).toBeUndefined();
    vi.doUnmock("../src/db/database.js");
    vi.resetModules();
  });
});

describe("tools deliberately withheld", () => {
  it("asks for a route by its two points, never by an id the model cannot know", () => {
    // The draft still takes trip-place UUIDs, for a route between two places
    // already in the plan. Nothing in a conversation carries those ids, so
    // advertising them is how the tool used to be uncallable; only the
    // coordinate form is offered.
    const navigation = PERSONAL_RESEARCH_TOOLS.find((tool) => tool.name === "navigation.route");
    expect(navigation).toBeDefined();
    const properties = Object.keys((navigation!.parameters as { properties: Record<string, unknown> }).properties);
    expect(properties).toEqual(["origin", "destination", "mode"]);
    expect(JSON.stringify(navigation)).not.toContain("PlaceId");
  });

  it("does not offer mobility.search", () => {
    expect(PERSONAL_RESEARCH_TOOLS.map((tool) => tool.name)).not.toContain("mobility.search");
  });
});

describe("dispatcher", () => {
  const base = {
    ctx: { correlationId: "c" } as never,
    ownerUserId: "00000000-0000-0000-0000-000000000002",
    tripId: "00000000-0000-0000-0000-000000000003",
    threadId: "00000000-0000-0000-0000-000000000004",
    runId: "00000000-0000-0000-0000-000000000001",
    userConfirmed: false,
    signal: new AbortController().signal,
  };

  it("refuses a tool it does not offer, without touching the database", async () => {
    const { createPersonalResearchDispatcher } = await import("../src/agents/personal-research-tools.js");
    const dispatch = createPersonalResearchDispatcher(base);
    expect(await dispatch({ id: "1", name: "mobility.search", arguments: {} }))
      .toEqual({ outcome: "UNAVAILABLE", reason: "UNKNOWN_TOOL" });
  });

  it("reports which fields were wrong, and nothing else", async () => {
    const { createPersonalResearchDispatcher } = await import("../src/agents/personal-research-tools.js");
    const dispatch = createPersonalResearchDispatcher(base);
    const result = await dispatch({ id: "1", name: "places.search", arguments: { latitude: 999 } }) as {
      outcome: string; reason: string; fields: string[];
    };
    expect(result.outcome).toBe("UNAVAILABLE");
    expect(result.reason).toBe("INVALID_ARGUMENTS");
    expect(result.fields).toContain("latitude");
    // Zod messages can quote the offending value, which may be user text.
    expect(JSON.stringify(result)).not.toContain("999");
  });

  it("holds a metered search for the traveller instead of running it", async () => {
    vi.resetModules();
    vi.doMock("../src/db/database.js", () => ({
      db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ userId: base.ownerUserId }] }) }) }) },
    }));
    const { createPersonalResearchDispatcher } = await import("../src/agents/personal-research-tools.js");
    const dispatch = createPersonalResearchDispatcher(base);
    const result = await dispatch({ id: "1", name: "flight.search", arguments: SAMPLE["flight.search"] }) as {
      outcome: string; capability: string;
    };
    expect(result.outcome).toBe("NEEDS_CONFIRMATION");
    expect(result.capability).toBe("flight.search");
    vi.doUnmock("../src/db/database.js");
    vi.resetModules();
  });

  it("runs it once the traveller has said yes", async () => {
    // Holding is only half the contract. Without the confirmation reaching
    // this dispatcher, every call answered NEEDS_CONFIRMATION including the
    // one right after the traveller agreed, so a metered capability could
    // never run at all — and the model, handed the same answer twice,
    // reported finding activities it had never looked for.
    vi.resetModules();
    vi.doMock("../src/db/database.js", () => ({
      db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ userId: base.ownerUserId }] }) }) }) },
    }));
    const executed = vi.fn(async () => ({ evidenceId: "e", outcome: "UNAVAILABLE" as const, summary: { outcome: "UNAVAILABLE" as const, summary: { errorCode: "NO_RESULTS" as const } } }));
    vi.doMock("../src/services/personal-research-service.js", () => ({ executePersonalResearch: executed }));
    const { createPersonalResearchDispatcher } = await import("../src/agents/personal-research-tools.js");
    const dispatch = createPersonalResearchDispatcher({ ...base, userConfirmed: true });
    const result = await dispatch({ id: "1", name: "flight.search", arguments: SAMPLE["flight.search"] }) as {
      outcome: string;
    };
    expect(executed).toHaveBeenCalledOnce();
    expect(result.outcome).not.toBe("NEEDS_CONFIRMATION");
    vi.doUnmock("../src/services/personal-research-service.js");
    vi.doUnmock("../src/db/database.js");
    vi.resetModules();
  });
});
