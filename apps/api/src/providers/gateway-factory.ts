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
    throw new Error(`Model gateway ${provider} is not fully configured: ${missingGatewaySettings(provider, configuration).join(", ")}`);
  }
  return buildLLM(provider, configuration);
}

/** Which env vars the selected provider still needs. Never their values. */
function missingGatewaySettings(
  provider: GatewayProvider,
  configuration: GatewayConfiguration | null,
): string[] {
  if (!configuration) return ["MODEL_GATEWAY_BASE_URL"];
  const missing: string[] = [];
  if (!configuration.apiKey) missing.push("MODEL_GATEWAY_API_KEY");
  if (!configuration.modelName) missing.push("MODEL_GATEWAY_MODEL");
  return missing.length ? missing : [`MODEL_GATEWAY_PROVIDER=${provider}`];
}

/**
 * Startup gate for every process that makes model-backed requests.
 *
 * Without it a blank credential is discovered once per user turn, deep inside
 * a durable task, where it surfaces as an unclassified `INTERNAL` failure long
 * after the message was accepted and stored. That is what happened when an
 * empty `MODEL_GATEWAY_API_KEY=` in a later `.env` block shadowed the real key
 * set above it — dotenv gives the last occurrence precedence — and every
 * conversation turn failed ~60ms in with no operator-visible signal.
 *
 * Failing at boot instead names the missing variables while someone is still
 * looking at the terminal. It never logs a credential, only the var names.
 */
export function assertModelGatewayEnvironment(): void {
  const provider = resolveProvider();
  const configuration = gatewayConfiguration(provider);
  if (!configuration?.apiKey || !configuration.modelName) {
    throw new Error(
      `Model gateway ${provider} is not fully configured: ${missingGatewaySettings(provider, configuration).join(", ")}. `
      + "Set it in apps/api/.env (see .env.example). Note dotenv gives the LAST occurrence of a key precedence, "
      + "so a later empty declaration silently blanks an earlier value.",
    );
  }
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
