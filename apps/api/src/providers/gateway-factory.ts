import type { ModelGateway } from "./model-gateway.js";
import { LLMGateway } from "./llm-gateway.js";
import { createRequestContext } from "../utils/context.js";

let currentGateway: ModelGateway | null = null;

type GatewayProvider = "openai" | "gemini" | "openai-compatible";

interface GatewayConfiguration {
  apiKey?: string;
  baseUrl?: string;
  modelName: string;
  promptVersion: string;
  maxRetries: number;
}

const GEMINI_OPENAI_COMPATIBLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

function resolveProvider(): GatewayProvider {
  const explicit = process.env.MODEL_GATEWAY_PROVIDER?.trim();
  if (
    explicit === "openai"
    || explicit === "gemini"
    || explicit === "openai-compatible"
  ) return explicit;
  throw new Error("MODEL_GATEWAY_PROVIDER must explicitly name a configured real model provider");
}

function gatewayConfiguration(provider: GatewayProvider): GatewayConfiguration | null {
  const promptVersion = process.env.MODEL_GATEWAY_PROMPT_VERSION ?? "1.1.0";
  const maxRetries = Number(process.env.MODEL_GATEWAY_MAX_RETRIES ?? 1);
  const apiKey = process.env.MODEL_GATEWAY_API_KEY?.trim();
  const configuredModel = process.env.MODEL_GATEWAY_MODEL?.trim();

  if (provider === "gemini") {
    return {
      apiKey,
      baseUrl: GEMINI_OPENAI_COMPATIBLE_BASE_URL,
      modelName: configuredModel ?? "",
      promptVersion,
      maxRetries,
    };
  }

  if (provider === "openai") {
    return {
      apiKey,
      modelName: configuredModel ?? "",
      promptVersion,
      maxRetries,
    };
  }

  if (provider === "openai-compatible") {
    const baseUrl = process.env.MODEL_GATEWAY_BASE_URL?.trim();
    if (!baseUrl) return null;
    return {
      apiKey,
      baseUrl,
      modelName: configuredModel ?? "",
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
    ctx,
    maxRetries: configuration.maxRetries,
  });
}

function createConfiguredGateway(): ModelGateway {
  const provider = resolveProvider();
  const configuration = gatewayConfiguration(provider);
  if (!configuration?.apiKey || !configuration.modelName) {
    throw new Error(`Model gateway ${provider} is not fully configured`);
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
