import { describe, expect, it, vi } from "vitest";
import { db } from "../src/db/database.js";
import { agentRuns } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { LLMGateway } from "../src/providers/llm-gateway.js";
import { createRequestContext } from "../src/utils/context.js";

const CATALOG_FIXTURE = {
  sourceId: "tokyo",
  canonicalPlaceId: "tokyo-jp",
  name: "Tokyo",
  country: "Japan",
  countryCode: "JP",
  admin1: "Tokyo",
  admin1Code: "JP-13",
  nearestCity: "Tokyo",
  datasetVersion: "location-introduction-v1",
  contentVersion: "location-intro-v1",
};

const VALID_CONTENT = "Tokyo is a city of contrasts — glass towers over neon-lit backstreets, vending machines beside tiny shrines, and a rhythm that shifts from morning calm to midnight rush. Wander between neighborhoods rather than chase a checklist, and let the city reveal itself over coffee, ramen, and long subway rides that feel like time travel.";

function makeClient(parsed: unknown) {
  return {
    chat: {
      completions: {
        parse: async () => ({
          choices: [{ message: { parsed } }],
          usage: { prompt: 12, completion: 5, total: 17 },
        }),
      },
    },
  };
}

describe("LLMGateway.generateLocationIntroduction", () => {
  it("records SUCCESS and persists an agent_runs row with agentName='public-content'", async () => {
    const before = await db.select().from(agentRuns).where(eq(agentRuns.skillName, "location.introduction"));
    before.forEach(r => void r); // no-op for lint

    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client: makeClient({ content: VALID_CONTENT }),
      maxRetries: 0,
    });

    const result = await gateway.generateLocationIntroduction({
      locale: "en",
      place: CATALOG_FIXTURE,
    });

    expect(result.content).toBe(VALID_CONTENT);
    expect(result.modelName).toBe("gpt-4o-mini");

    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.skillName, "location.introduction"));
    expect(runs.length).toBeGreaterThan(0);
    const ours = runs[0];
    expect(ours.agentName).toBe("public-content");
    expect(ours.status).toBe("SUCCESS");
    expect(JSON.stringify(ours)).not.toContain("Tokyo");
    expect(ours.outputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects forbidden content (today/current) and fails closed with POLICY_DENIED", async () => {
    const polluted = "Today, the city feels bright and lively, and currently the markets are open early in the morning for visitors who arrive on foot.";
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client: makeClient({ content: polluted }),
      maxRetries: 0,
    });

    await expect(gateway.generateLocationIntroduction({
      locale: "en",
      place: CATALOG_FIXTURE,
    })).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("records SCHEMA_PARSE and fails closed when content is too short", async () => {
    const gateway = new LLMGateway({
      apiKey: "test",
      provider: "openai",
      modelName: "gpt-4o-mini",
      promptVersion: "1.0.0",
      ctx: createRequestContext(),
      client: makeClient({ content: "too short" }),
      maxRetries: 0,
    });

    await expect(gateway.generateLocationIntroduction({
      locale: "en",
      place: CATALOG_FIXTURE,
    })).rejects.toMatchObject({ code: "SCHEMA_PARSE" });

    const runs = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.skillName, "location.introduction"));
    expect(runs.some(r => r.errorCode === "SCHEMA_PARSE")).toBe(true);
    expect(runs.some(r => r.agentName === "public-content")).toBe(true);
  });
});