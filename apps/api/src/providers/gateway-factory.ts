import type { ModelGateway } from "./model-gateway.js";
import { MockModelGateway } from "./model-gateway.js";
import { LLMGateway } from "./llm-gateway.js";
import { createRequestContext } from "../utils/context.js";

let currentGateway: ModelGateway | null = null;

function resolveProvider(): "mock" | "openai" {
  const explicit = process.env.MODEL_GATEWAY_PROVIDER;
  if (explicit === "mock" || explicit === "openai") return explicit;
  return process.env.OPENAI_API_KEY ? "openai" : "mock";
}

function buildLLM(): LLMGateway {
  const ctx = createRequestContext();
  return new LLMGateway({
    apiKey: process.env.OPENAI_API_KEY!,
    modelName: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    promptVersion: process.env.OPENAI_PROMPT_VERSION ?? "1.0.0",
    mock: new MockModelGateway(),
    ctx,
    maxRetries: Number(process.env.OPENAI_MAX_RETRIES ?? 1),
  });
}

export function modelGateway(): ModelGateway {
  if (currentGateway) return currentGateway;
  const provider = resolveProvider();
  if (provider === "mock" || !process.env.OPENAI_API_KEY) {
    currentGateway = new MockModelGateway();
  } else {
    currentGateway = buildLLM();
  }
  return currentGateway;
}

export function createModelGateway(): ModelGateway {
  const provider = resolveProvider();
  if (provider === "mock" || !process.env.OPENAI_API_KEY) {
    return new MockModelGateway();
  }
  return buildLLM();
}

export function __setModelGatewayForTests(gateway: ModelGateway | null): void {
  currentGateway = gateway;
}