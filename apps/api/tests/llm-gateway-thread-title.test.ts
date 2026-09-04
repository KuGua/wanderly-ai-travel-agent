import { describe, expect, it, vi } from "vitest";

import { LLMGateway, ModelGatewayError } from "../src/providers/llm-gateway.js";
import { createRequestContext } from "../src/utils/context.js";

vi.mock("openai", () => ({ default: class FakeOpenAI {} }));

function buildGateway(parse: ReturnType<typeof vi.fn>, maxRetries = 0) {
  return new LLMGateway({
    apiKey: "test",
    provider: "openai",
    modelName: "gpt-4o-mini",
    promptVersion: "1.0.0",
    ctx: createRequestContext(),
    client: { chat: { completions: { parse } } } as never,
    maxRetries,
  });
}

const MESSAGES = [{ text: "我想去东京，签证要准备什么" }, { text: "大概九月出发" }];

describe("LLMGateway.generateThreadTitle", () => {
  it("returns the parsed title", async () => {
    const parse = vi.fn().mockResolvedValue({
      choices: [{ message: { parsed: { title: "东京签证准备" } } }],
    });

    const result = await buildGateway(parse).generateThreadTitle({ locale: "zh", messages: MESSAGES });

    expect(result).toEqual({ title: "东京签证准备" });
  });

  // There is no current question on this path, so the validated locale is the
  // only language authority (LLM-GATEWAY.md §User-visible language contract).
  // A Chinese conversation asked for in English must still be titled in
  // English, and vice versa.
  it.each([
    ["zh", "Simplified Chinese"],
    ["en", "English"],
  ] as const)("takes its language from the requested locale (%s)", async (locale, expected) => {
    const parse = vi.fn().mockResolvedValue({
      choices: [{ message: { parsed: { title: "Visa prep" } } }],
    });

    await buildGateway(parse).generateThreadTitle({ locale, messages: MESSAGES });

    const messages = parse.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain(`Write the title in ${expected}`);
  });

  // Only the owner's own messages cross this boundary — never the assistant's
  // replies, the profile, the trip brief, or another thread.
  it("sends nothing but the supplied message texts", async () => {
    const parse = vi.fn().mockResolvedValue({
      choices: [{ message: { parsed: { title: "Visa prep" } } }],
    });

    await buildGateway(parse).generateThreadTitle({ locale: "en", messages: MESSAGES });

    const messages = parse.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(JSON.parse(messages[1].content)).toEqual({
      messages: ["我想去东京，签证要准备什么", "大概九月出发"],
    });
  });

  it("fails closed when the model returns an unusable shape", async () => {
    const parse = vi.fn().mockResolvedValue({ choices: [{ message: { parsed: { title: "" } } }] });

    await expect(buildGateway(parse).generateThreadTitle({ locale: "en", messages: MESSAGES }))
      .rejects.toBeInstanceOf(ModelGatewayError);
  });

  it("fails closed when the provider call throws", async () => {
    const parse = vi.fn().mockRejectedValue(new Error("upstream exploded"));

    await expect(buildGateway(parse).generateThreadTitle({ locale: "en", messages: MESSAGES }))
      .rejects.toBeInstanceOf(ModelGatewayError);
  });

  it("retries a malformed response before giving up", async () => {
    const parse = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { parsed: null } }] })
      .mockResolvedValueOnce({ choices: [{ message: { parsed: { title: "Visa prep" } } }] });

    const result = await buildGateway(parse, 1).generateThreadTitle({ locale: "en", messages: MESSAGES });

    expect(result).toEqual({ title: "Visa prep" });
    expect(parse).toHaveBeenCalledTimes(2);
  });
});
