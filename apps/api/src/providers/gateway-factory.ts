import type { ModelGateway } from "./model-gateway.js";
import { MockModelGateway } from "./model-gateway.js";
import { LLMGateway } from "./llm-gateway.js";
import { createRequestContext } from "../utils/context.js";

let currentGateway: ModelGateway | null = null;

type GatewayProvider = "mock" | "openai" | "gemini" | "openai-compatible";

interface GatewayConfiguration {
  apiKey?: string;
  baseUrl?: string;
  modelName: string;
  promptVersion: string;
  maxRetries: number;
}

const GEMINI_OPENAI_COMPATIBLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

function resolveProvider(): GatewayProvider {
  const explicit = process.env.MODEL_GATEWAY_PROVIDER;
  if (
    explicit === "mock"
    || explicit === "openai"
    || explicit === "gemini"
    || explicit === "openai-compatible"
  ) return explicit;
  if (process.env.GEMINI_API_KEY) return "gemini";
  return process.env.OPENAI_API_KEY ? "openai" : "mock";
}

function gatewayConfiguration(provider: GatewayProvider): GatewayConfiguration | null {
  const promptVersion = process.env.MODEL_GATEWAY_PROMPT_VERSION ?? process.env.OPENAI_PROMPT_VERSION ?? "1.0.0";
  const maxRetries = Number(process.env.MODEL_GATEWAY_MAX_RETRIES ?? process.env.OPENAI_MAX_RETRIES ?? 1);

  if (provider === "gemini") {
    return {
      // OPENAI_API_KEY remains a compatibility fallback for existing local .env files
      // that stored a Gemini key before GEMINI_API_KEY was introduced.
      apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY,
      baseUrl: process.env.GEMINI_BASE_URL || GEMINI_OPENAI_COMPATIBLE_BASE_URL,
      modelName: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      promptVersion,
      maxRetries,
    };
  }

  if (provider === "openai") {
    return {
      apiKey: process.env.OPENAI_API_KEY,
      modelName: process.env.OPENAI_MODEL || "gpt-4o-mini",
      promptVersion,
      maxRetries,
    };
  }

  if (provider === "openai-compatible") {
    if (!process.env.MODEL_GATEWAY_BASE_URL) return null;
    return {
      apiKey: process.env.MODEL_GATEWAY_API_KEY,
      baseUrl: process.env.MODEL_GATEWAY_BASE_URL,
      modelName: process.env.MODEL_GATEWAY_MODEL ?? "",
      promptVersion,
      maxRetries,
    };
  }

  return null;
}

function buildLLM(provider: Exclude<GatewayProvider, "mock">, configuration: GatewayConfiguration): LLMGateway {
  const ctx = createRequestContext();
  return new LLMGateway({
    apiKey: configuration.apiKey!,
    provider,
    baseUrl: configuration.baseUrl,
    modelName: configuration.modelName,
    promptVersion: configuration.promptVersion,
    mock: new MockModelGateway(),
    ctx,
    maxRetries: configuration.maxRetries,
  });
}

function createConfiguredGateway(): ModelGateway {
  const provider = resolveProvider();
  const configuration = gatewayConfiguration(provider);
  if (provider === "mock" || !configuration?.apiKey || !configuration.modelName) {
    return new MockModelGateway();
  }
  return buildLLM(provider, configuration);
}

export function modelGateway(): ModelGateway {
  if (currentGateway) return currentGateway;
  currentGateway = createConfiguredGateway();
  return currentGateway;
}

export function createModelGateway(): ModelGateway {
  return createConfiguredGateway();
}

export function __setModelGatewayForTests(gateway: ModelGateway | null): void {
  currentGateway = gateway;
}
