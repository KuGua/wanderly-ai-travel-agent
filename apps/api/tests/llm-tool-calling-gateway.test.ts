import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMGateway, ModelGatewayError } from "../src/providers/llm-gateway.js";
import { createRequestContext } from "../src/utils/context.js";

const oldEnabled = process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED;
afterEach(() => { process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = oldEnabled; });

describe("LLMGateway planning tools", () => {
  it("feeds a registered tool result into a final model turn", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ id: "call-1", function: { name: "flight.search", arguments: JSON.stringify({ originId: "SFO", destinationId: "NRT", tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD" }) } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ plan: { destination: "NRT", flights: [], stays: [], ground: [], generatedAt: "2026-01-01T00:00:00Z" } }) } }] });
    const gateway = new LLMGateway({ apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test", ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } } });
    const dispatchTool = vi.fn().mockResolvedValue({ outcome: "LIVE", queryId: "11111111-1111-4111-8111-111111111111", offers: [] });
    const result = await gateway.generateStructuredPlanWithTools!({
      destination: "NRT", stays: [], ground: [], memberPreferences: {}, maxTurns: 2,
      flightSearchConstraints: { originIds: ["SFO"], destinationIds: ["NRT"], tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD" },
      tools: [{ name: "flight.search", description: "test", parameters: {} }], dispatchTool,
    });
    expect(result.destination).toBe("NRT");
    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    const finalMessages = create.mock.calls[1][0].messages as Array<Record<string, unknown>>;
    expect(finalMessages.some((message) => message.role === "tool" && String(message.content).includes("LIVE"))).toBe(true);
    const initialMessages = create.mock.calls[0][0].messages as Array<Record<string, unknown>>;
    expect(String(initialMessages[1]?.content)).toContain('"originIds":["SFO"]');
  });

  it("fails without an extra tool dispatch when the turn limit is exhausted", async () => {
    process.env.MODEL_GATEWAY_TOOL_CALLING_ENABLED = "true";
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { tool_calls: [{ id: "call-1", function: { name: "flight.search", arguments: "{}" } }] } }] });
    const gateway = new LLMGateway({ apiKey: "test", provider: "openai", modelName: "test", promptVersion: "test", ctx: createRequestContext(), client: { chat: { completions: { create, parse: vi.fn() } } } });
    const dispatchTool = vi.fn().mockResolvedValue({ outcome: "UNAVAILABLE", code: "NO_RESULTS" });
    await expect(gateway.generateStructuredPlanWithTools!({ destination: "NRT", stays: [], ground: [], memberPreferences: {}, maxTurns: 1, flightSearchConstraints: { originIds: ["SFO"], destinationIds: ["NRT"], tripType: "ONE_WAY", departureDate: "2026-10-01", adults: 1, cabin: "ECONOMY", currency: "USD" }, tools: [{ name: "flight.search", description: "test", parameters: {} }], dispatchTool })).rejects.toMatchObject<ModelGatewayError>({ code: "TOOL_CALL_MAX_TURNS" });
    expect(dispatchTool).toHaveBeenCalledOnce();
  });
});
