import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMGateway, ModelGatewayError } from "../src/providers/llm-gateway.js";
import { SHARED_TOOL_PLANNING_SYSTEM_PROMPT } from "../src/providers/shared-planning-prompts.js";
import { createRequestContext } from "../src/utils/context.js";

const oldEnabled = process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED;
afterEach(() => { process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = oldEnabled; });

describe("LLMGateway planning tools", () => {
  it("feeds a registered tool result into a final model turn", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ id: "call-1", function: { name: "flight.search", arguments: JSON.stringify({ originId: "SFO", destinationId: "NRT", tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD" }) } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ plan: { destination: "NRT", flights: [], generatedAt: "2026-01-01T00:00:00Z" } }) } }] });
    const gateway = new LLMGateway({ apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test", ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } } });
    const dispatchTool = vi.fn().mockResolvedValue({ outcome: "LIVE", queryId: "11111111-1111-4111-8111-111111111111", offers: [] });
    const result = await gateway.generateStructuredPlanWithTools!({
      destination: "NRT", stays: [], memberPreferences: {}, maxTurns: 2,
      flightSearchConstraints: { originIds: ["SFO"], destinationIds: ["NRT"], tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD" },
      tools: [{ name: "flight.search", description: "test", parameters: {} }], dispatchTool,
    });
    expect(result.destination).toBe("NRT");
    expect(result.stays).toEqual([]);
    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    const finalMessages = create.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    expect(finalMessages.some((message) => message.role === "tool" && String(message.content).includes("LIVE"))).toBe(true);
    const initialMessages = create.mock.calls[0][0].messages as Array<Record<string, unknown>>;
    expect(initialMessages[0]).toEqual({ role: "system", content: SHARED_TOOL_PLANNING_SYSTEM_PROMPT });
    expect(SHARED_TOOL_PLANNING_SYSTEM_PROMPT).toContain("not a user-facing assistant");
    expect(SHARED_TOOL_PLANNING_SYSTEM_PROMPT).toContain("Personal Agent research");
    expect(SHARED_TOOL_PLANNING_SYSTEM_PROMPT).toContain("cannot contact a traveller");
    expect(SHARED_TOOL_PLANNING_SYSTEM_PROMPT).toContain("do not request a second hotel-tool confirmation");
    expect(String(initialMessages[1]?.content)).toContain('"originIds":["SFO"]');
  });

  /**
   * 2026-09-05: a run answered both its flight cells in turn one, then spent
   * turns two through ten re-issuing `flight.search` for the same two cells.
   * The cache served each instantly and spent no supplier quota, but every
   * repeat consumed a turn; the budget ran out and the run was thrown away,
   * with "Do not call flight.search again" in front of the model each pass.
   * Telling it not to is not the same as making it impossible.
   */
  it("withdraws flight.search once every required cell has an answer", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const flightCall = (id: string, destinationId: string) => ({
      id, function: { name: "flight.search", arguments: JSON.stringify({ originId: "SFO", destinationId }) },
    });
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [flightCall("c1", "NRT"), flightCall("c2", "HND")] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        plan: { destination: "NRT", flights: [], generatedAt: "2026-01-01T00:00:00Z" },
      }) } }] });
    const gateway = new LLMGateway({
      apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test",
      ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } },
    });
    const dispatchTool = vi.fn().mockResolvedValue({
      outcome: "LIVE", queryId: "11111111-1111-4111-8111-111111111111", offers: [],
    });
    await gateway.generateStructuredPlanWithTools!({
      destination: "NRT", stays: [], memberPreferences: {}, maxTurns: 4,
      flightSearchConstraints: {
        originIds: ["SFO"], destinationIds: ["NRT", "HND"],
        tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD",
      },
      tools: [
        { name: "flight.search", description: "test", parameters: {} },
        { name: "activities.search", description: "test", parameters: {} },
      ],
      dispatchTool,
    });

    // First turn offers both tools; once both cells are answered the second
    // turn offers only what is left to do.
    const firstTools = (create.mock.calls[0][0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(firstTools).toContain("flight.search");
    const secondTools = (create.mock.calls[1][0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(secondTools).not.toContain("flight.search");
    expect(secondTools).toContain("activities.search");
  });

  /**
   * Withdrawing a tool from the list is not the same as making it impossible:
   * dispatch keyed off the call's name alone, so the model kept calling
   * `flight.search` after it was withdrawn, kept reaching the supplier, and
   * kept colliding with its own `provider_search_runs` row — a raw unique-index
   * error the model then read as the flight cell having failed.
   */
  it("refuses a tool the turn did not offer instead of dispatching it", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const flightCall = (id: string, destinationId: string) => ({
      id, function: { name: "flight.search", arguments: JSON.stringify({ originId: "SFO", destinationId }) },
    });
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [flightCall("c1", "NRT")] } }] })
      // Withdrawn now — and asked for anyway, in different argument text so no
      // signature cache can recognise it.
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{
        id: "c2",
        function: { name: "flight.search", arguments: JSON.stringify({ destinationId: "NRT", originId: "SFO" }) },
      }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        plan: { destination: "NRT", flights: [], generatedAt: "2026-01-01T00:00:00Z" },
      }) } }] });
    const gateway = new LLMGateway({
      apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test",
      ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } },
    });
    const dispatchTool = vi.fn().mockResolvedValue({
      outcome: "LIVE", queryId: "11111111-1111-4111-8111-111111111111", offers: [],
    });
    const result = await gateway.generateStructuredPlanWithTools!({
      destination: "NRT", stays: [], memberPreferences: {}, maxTurns: 4,
      flightSearchConstraints: {
        originIds: ["SFO"], destinationIds: ["NRT"],
        tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD",
      },
      tools: [
        { name: "flight.search", description: "test", parameters: {} },
        { name: "activities.search", description: "test", parameters: {} },
      ],
      dispatchTool,
    });

    expect(result.destination).toBe("NRT");
    // The supplier was asked exactly once, on the turn the tool was offered.
    expect(dispatchTool).toHaveBeenCalledOnce();
    // And the model was told why, in a shape it can act on.
    const finalMessages = create.mock.calls[2][0].messages as Array<Record<string, unknown>>;
    expect(finalMessages.some((m) => m.role === "tool"
      && String(m.content).includes("TOOL_NOT_AVAILABLE_THIS_TURN"))).toBe(true);
  });

  /**
   * The same route asked for again in different argument text. The signature
   * cache misses it; the flight cell key does not.
   */
  it("recognises a re-asked flight route however the arguments are written", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [
        { id: "c1", function: { name: "flight.search", arguments: JSON.stringify({ originId: "SFO", destinationId: "NRT" }) } },
        { id: "c2", function: { name: "flight.search", arguments: JSON.stringify({ destinationId: "NRT", originId: "SFO", cabin: "ECONOMY" }) } },
      ] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        plan: { destination: "NRT", flights: [], generatedAt: "2026-01-01T00:00:00Z" },
      }) } }] });
    const gateway = new LLMGateway({
      apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test",
      ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } },
    });
    const dispatchTool = vi.fn().mockResolvedValue({
      outcome: "LIVE", queryId: "11111111-1111-4111-8111-111111111111", offers: [],
    });
    await gateway.generateStructuredPlanWithTools!({
      destination: "NRT", stays: [], memberPreferences: {}, maxTurns: 3,
      flightSearchConstraints: {
        originIds: ["SFO"], destinationIds: ["NRT"],
        tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD",
      },
      tools: [{ name: "flight.search", description: "test", parameters: {} }],
      dispatchTool,
    });

    // One route, one supplier call — the second wording is the same cell.
    expect(dispatchTool).toHaveBeenCalledOnce();
  });

  it("does not spend the turn budget on calls it has already answered", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const repeat = { id: "c1", function: { name: "activities.search", arguments: JSON.stringify({ destinationId: "NRT" }) } };
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [repeat] } }] })
      // Two turns of nothing but the same call again. Before the refund these
      // ate two of the three turns and the run died without a plan.
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ ...repeat, id: "c2" }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ ...repeat, id: "c3" }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        plan: { destination: "NRT", flights: [], generatedAt: "2026-01-01T00:00:00Z" },
      }) } }] });
    const gateway = new LLMGateway({
      apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test",
      ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } },
    });
    const dispatchTool = vi.fn().mockResolvedValue({ outcome: "LIVE", offers: [] });
    const result = await gateway.generateStructuredPlanWithTools!({
      destination: "NRT", stays: [], memberPreferences: {}, maxTurns: 3,
      flightSearchConstraints: {
        originIds: [], destinationIds: [],
        tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD",
      },
      tools: [{ name: "activities.search", description: "test", parameters: {} }],
      dispatchTool,
    });

    expect(result.destination).toBe("NRT");
    // The supplier was asked once; the repeats were answered from the record.
    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(4);
  });

  it("normalizes null optional plan arrays returned by an OpenAI-compatible provider", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{
        id: "call-1",
        function: { name: "flight.search", arguments: JSON.stringify({ originId: "SFO", destinationId: "NRT" }) },
      }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        plan: {
          destination: "NRT",
          destinationCandidatesEvaluated: null,
          flights: [],
          stays: [],
          activities: null,
          generatedAt: "2026-01-01T00:00:00Z",
          constraintReferences: null,
          publicExplanationTokens: null,
        },
      }) } }] });
    const gateway = new LLMGateway({
      apiKey: "test", provider: "gemini", modelName: "test", promptVersion: "test",
      ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } },
    });

    await expect(gateway.generateStructuredPlanWithTools!({
      destination: "NRT", stays: [], memberPreferences: {}, maxTurns: 2,
      flightSearchConstraints: {
        originIds: ["SFO"], destinationIds: ["NRT"], tripType: "ONE_WAY",
        departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD",
      },
      tools: [{ name: "flight.search", description: "test", parameters: {} }],
      dispatchTool: vi.fn().mockResolvedValue({
        outcome: "LIVE", queryId: "11111111-1111-4111-8111-111111111111", offers: [],
      }),
    })).resolves.toEqual({
      destination: "NRT",
      destinationCandidatesEvaluated: undefined,
      flights: [],
      stays: [],
      activities: undefined,
      generatedAt: "2026-01-01T00:00:00Z",
      constraintReferences: undefined,
      publicExplanationTokens: undefined,
    });
  });

  it("retries a malformed final JSON response within the bounded model loop", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{
        id: "call-1",
        function: { name: "flight.search", arguments: JSON.stringify({ originId: "SFO", destinationId: "NRT" }) },
      }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ plan: { destination: "NRT" } }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({
        plan: { destination: "NRT", flights: [], stays: [], generatedAt: "2026-01-01T00:00:00Z" },
      }) } }] });
    const gateway = new LLMGateway({
      apiKey: "test", provider: "gemini", modelName: "test", promptVersion: "test",
      ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } },
    });

    await expect(gateway.generateStructuredPlanWithTools!({
      destination: "NRT", stays: [], memberPreferences: {}, maxTurns: 3,
      flightSearchConstraints: {
        originIds: ["SFO"], destinationIds: ["NRT"], tripType: "ONE_WAY",
        departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD",
      },
      tools: [{ name: "flight.search", description: "test", parameters: {} }],
      dispatchTool: vi.fn().mockResolvedValue({
        outcome: "LIVE", queryId: "11111111-1111-4111-8111-111111111111", offers: [],
      }),
    })).resolves.toMatchObject({ destination: "NRT" });
    expect(create).toHaveBeenCalledTimes(3);
    const correctionMessages = create.mock.calls[2][0].messages as Array<Record<string, unknown>>;
    expect(correctionMessages.some((message) =>
      message.role === "system" && String(message.content).includes("plan.flights"),
    )).toBe(true);
  });

  it("fails without an extra tool dispatch when the turn limit is exhausted", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { tool_calls: [{ id: "call-1", function: { name: "flight.search", arguments: "{}" } }] } }] });
    const gateway = new LLMGateway({ apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test", ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } } });
    const dispatchTool = vi.fn().mockResolvedValue({ outcome: "UNAVAILABLE", code: "NO_RESULTS" });
    await expect(gateway.generateStructuredPlanWithTools!({ destination: "NRT", stays: [], memberPreferences: {}, maxTurns: 1, flightSearchConstraints: { originIds: ["SFO"], destinationIds: ["NRT"], tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD" }, tools: [{ name: "flight.search", description: "test", parameters: {} }], dispatchTool })).rejects.toMatchObject<ModelGatewayError>({ code: "TOOL_CALL_MAX_TURNS" });
    expect(dispatchTool).toHaveBeenCalledOnce();
  });

  it("requires every flight matrix cell and serves duplicate calls from the loop cache", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const toolCall = (id: string, destinationId: string) => ({
      id,
      type: "function",
      extra_content: { google: { thought_signature: `signature-${id}` } },
      function: { name: "flight.search", arguments: JSON.stringify({ originId: "SIN", destinationId }) },
    });
    const prematureFinal = { choices: [{ message: { content: JSON.stringify({ plan: { destination: "NRT" } }) } }] };
    const finalPlan = {
      choices: [{ message: { content: JSON.stringify({
        plan: { destination: "NRT", flights: [], stays: [], generatedAt: "2026-01-01T00:00:00Z" },
      }) } }],
    };
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [toolCall("call-nrt", "NRT")] } }] })
      .mockResolvedValueOnce(prematureFinal)
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [toolCall("call-nrt-duplicate", "NRT")] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [toolCall("call-lis", "LIS")] } }] })
      .mockResolvedValueOnce(finalPlan);
    const gateway = new LLMGateway({
      apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test",
      ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } },
    });
    const dispatchTool = vi.fn(async (call: { arguments: unknown }) => ({
      outcome: "LIVE" as const,
      queryId: "11111111-1111-4111-8111-111111111111",
      offers: [],
      route: call.arguments,
    }));
    const beforeFinal = vi.fn(async () => undefined);

    await expect(gateway.generateStructuredPlanWithTools!({
      destination: "NRT", destinationCandidates: ["NRT", "LIS"], stays: [], memberPreferences: {}, maxTurns: 5,
      flightSearchConstraints: {
        originIds: ["SIN"], destinationIds: ["NRT", "LIS"], tripType: "ROUND_TRIP",
        departureDate: "2026-10-10", returnDate: "2026-10-17", adults: 1, cabin: "ECONOMY", currency: "USD",
      },
      tools: [{ name: "flight.search", description: "test", parameters: {} }], dispatchTool, beforeFinal,
    })).resolves.toMatchObject({ destination: "NRT" });

    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(dispatchTool.mock.calls.map(([call]) => (call.arguments as { destinationId: string }).destinationId)).toEqual(["NRT", "LIS"]);
    expect(beforeFinal).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(5);
    expect(create.mock.calls[1][0].tool_choice).toEqual({ type: "function", function: { name: "flight.search" } });
    expect(create.mock.calls[1][0]).not.toHaveProperty("response_format");
    expect(create.mock.calls[4][0].response_format).toEqual({ type: "json_object" });
    expect(create.mock.calls[4][0].tool_choice).toBe("none");
    const firstAssistantToolMessage = (create.mock.calls[1][0].messages as Array<Record<string, unknown>>)
      .find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
    expect(firstAssistantToolMessage).toMatchObject({
      tool_calls: [{ extra_content: { google: { thought_signature: "signature-call-nrt" } } }],
    });
    const progressMessages = (create.mock.calls[3][0].messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === "system" && String(message.content).includes("serverFlightResearchProgress"));
    expect(progressMessages.length).toBeGreaterThan(0);
    const finalInstructions = (create.mock.calls[4][0].messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === "system" && String(message.content).includes("Authoritative flight research is complete"));
    expect(finalInstructions).toHaveLength(1);
    expect(String(finalInstructions[0]?.content)).toContain("one top-level key named plan");
    expect(String(finalInstructions[0]?.content)).toContain("do not set them to null");
    expect(String(finalInstructions[0]?.content)).toContain('only compact {"id":"exact evidence id"}');
  });

  it("wraps a raw model request failure as a classified ModelGatewayError instead of leaking it", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const toolCall = (id: string, destinationId: string) => ({
      id, function: { name: "flight.search", arguments: JSON.stringify({ originId: "SIN", destinationId }) },
    });
    // The first turn succeeds and requires a second, forced-tool-choice turn
    // (the required matrix still has a MISSING cell). That second raw request
    // rejects with a generic, unclassified error — the exact shape a
    // provider-side 400 arrives as — to prove it surfaces as a bounded,
    // retry-classifiable ModelGatewayError rather than the raw SDK error.
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [toolCall("call-nrt", "NRT")] } }] })
      .mockRejectedValueOnce(new Error("400 Bad Request"));
    const gateway = new LLMGateway({
      apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test",
      ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } },
    });
    const dispatchTool = vi.fn(async () => ({
      outcome: "LIVE" as const, queryId: "11111111-1111-4111-8111-111111111111", offers: [],
    }));

    await expect(gateway.generateStructuredPlanWithTools!({
      destination: "NRT", destinationCandidates: ["NRT", "LIS"], stays: [], memberPreferences: {}, maxTurns: 5,
      flightSearchConstraints: {
        originIds: ["SIN"], destinationIds: ["NRT", "LIS"], tripType: "ROUND_TRIP",
        departureDate: "2026-10-10", returnDate: "2026-10-17", adults: 1, cabin: "ECONOMY", currency: "USD",
      },
      tools: [{ name: "flight.search", description: "test", parameters: {} }], dispatchTool,
    })).rejects.toMatchObject<ModelGatewayError>({ code: "UPSTREAM_FAILURE" });
  });
});
