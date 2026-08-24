import { randomUUID } from "node:crypto";
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

export function modelGateway(): ModelGateway {
  if (currentGateway) return currentGateway;

  const provider = resolveProvider();
  if (provider === "mock" || !process.env.OPENAI_API_KEY) {
    currentGateway = new MockModelGateway();
    return currentGateway;
  }

  const ctx = createRequestContext();
  currentGateway = new LLMGateway({
    apiKey: process.env.OPENAI_API_KEY,
    modelName: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    promptVersion: process.env.PROMPT_VERSION ?? "1.0.0",
    mock: new MockModelGateway(),
    ctx,
    maxRetries: 1,
  });
  return currentGateway;
}

export function createModelGateway(): ModelGateway {
  // Exposed for tests; returns a fresh gateway built against current env.
  const provider = resolveProvider();
  if (provider === "mock" || !process.env.OPENAI_API_KEY) {
    return new MockModelGateway();
  }
  const ctx = createRequestContext();
  return new LLMGateway({
    apiKey: process.env.OPENAI_API_KEY,
    modelName: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    promptVersion: process.env.PROMPT_VERSION ?? "1.0.0",
    mock: new MockModelGateway(),
    ctx,
    maxRetries: 1,
  });
}

export function __setModelGatewayForTests(gateway: ModelGateway | null): void {
  currentGateway = gateway;
}

export function __newCorrelationId(): string {
  return randomUUID();
}