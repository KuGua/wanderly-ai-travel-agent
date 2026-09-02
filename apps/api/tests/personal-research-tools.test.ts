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
  it("does not offer navigation.route", () => {
    // Its draft takes two trip-place UUIDs and nothing in the conversation
    // context carries them, so the model could only ever call it wrongly.
    expect(PERSONAL_RESEARCH_TOOLS.map((tool) => tool.name)).not.toContain("navigation.route");
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
});
