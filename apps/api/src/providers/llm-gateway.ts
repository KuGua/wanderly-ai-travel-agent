import { createHash } from "node:crypto";
import type { FlightOffer, GroundOffer, PlanDiff, StayOffer } from "../types/domain.js";
import type { ModelGateway } from "./model-gateway.js";
import type { AgentRunTokens } from "../observability/agent-runs.js";
import { recordAgentRun } from "../observability/agent-runs.js";
import type { RequestContext } from "../utils/context.js";
import { metrics } from "../observability/metrics.js";

export interface LLMGatewayOptions {
  apiKey: string;
  modelName: string;
  promptVersion: string;
  mock: ModelGateway;
  ctx: RequestContext;
  maxRetries?: number;
  /** Injected for tests; production code resolves the OpenAI client lazily. */
  client?: unknown;
}

interface OpenAIClientLike {
  responses: {
    create: (req: Record<string, unknown>) => Promise<{
      output_parsed?: Record<string, unknown> | null;
      output_text?: string | null;
      usage?: AgentRunTokens;
    }>;
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

function hashOutput(output: unknown): string {
  return createHash("sha256").update(canonicalize(output)).digest("hex");
}

function classifyError(err: unknown): string {
  if (!err) return "UNKNOWN";
  if ((err as { name?: string }).name === "AbortError") return "TIMEOUT";
  const message = (err as Error).message ?? "";
  if (/timeout/i.test(message)) return "TIMEOUT";
  if (/parse|schema/i.test(message)) return "SCHEMA_PARSE";
  if (/network|fetch|ENOTFOUND|ECONNRESET/i.test(message)) return "NETWORK";
  if (/5\d{2}/.test(message)) return "UPSTREAM_5XX";
  return "UPSTREAM_FAILURE";
}

function summarizePayload(destination: string, payload: { flights?: FlightOffer[]; stays?: StayOffer[]; ground?: GroundOffer[] }): string {
  return JSON.stringify({
    destination,
    flights: payload.flights?.length ?? 0,
    stays: payload.stays?.length ?? 0,
    ground: payload.ground?.length ?? 0,
  });
}

export class LLMGateway implements ModelGateway {
  constructor(private readonly options: LLMGatewayOptions) {}

  private async loadClient(): Promise<OpenAIClientLike> {
    if (this.options.client) return this.options.client as OpenAIClientLike;
    const mod = await import("openai");
    const OpenAI = (mod as unknown as { default: new (config: { apiKey: string }) => OpenAIClientLike }).default;
    return new OpenAI({ apiKey: this.options.apiKey });
  }

  private async loadZodTextFormat(): Promise<(schema: unknown, name: string) => unknown> {
    const mod = await import("openai/helpers/zod");
    return (mod as unknown as { zodTextFormat: (schema: unknown, name: string) => unknown }).zodTextFormat;
  }

  private async loadPlanOutputSchema(): Promise<unknown> {
    const mod = await import("../policy/plan-output-validator.js");
    return (mod as { planOutputSchema: unknown }).planOutputSchema;
  }

  async generateStructuredPlan(params: {
    destination: string;
    flights: FlightOffer[];
    stays: StayOffer[];
    ground: GroundOffer[];
    memberPreferences: Record<string, unknown>;
    signal?: AbortSignal;
    ctx?: { correlationId: string };
  }): Promise<Record<string, unknown>> {
    const ctx = params.ctx ?? this.options.ctx;
    const signal = params.signal;
    const start = Date.now();

    const fallbackToMock = async (errorCode: string, tokens?: AgentRunTokens): Promise<Record<string, unknown>> => {
      const plan = await this.options.mock.generateStructuredPlan({
        destination: params.destination,
        flights: params.flights,
        stays: params.stays,
        ground: params.ground,
        memberPreferences: params.memberPreferences,
        signal,
      });
      await recordAgentRun({
        ctx,
        skillName: "plan.comparison",
        agentName: "shared",
        modelName: this.options.modelName,
        promptVersion: this.options.promptVersion,
        outputHash: hashOutput(plan),
        latencyMs: Date.now() - start,
        status: "FALLBACK",
        errorCode,
        tokens,
      });
      metrics.inc("provider_fallback_total", { provider: this.options.modelName, outcome: errorCode });
      return plan;
    };

    let client: OpenAIClientLike;
    let zodTextFormat: (schema: unknown, name: string) => unknown;
    let planOutputSchema: unknown;
    try {
      client = await this.loadClient();
      zodTextFormat = await this.loadZodTextFormat();
      planOutputSchema = await this.loadPlanOutputSchema();
    } catch (err) {
      return fallbackToMock(classifyError(err));
    }

    const maxRetries = this.options.maxRetries ?? 1;
    let lastError = "";

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await client.responses.create({
          model: this.options.modelName,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "text",
                  text: `You are the Shared Trip planning skill. Return only JSON matching the supplied schema (prompt_version=${this.options.promptVersion}). Never include raw profile, passport, or nationality fields. Use only the snapshot constraints and the supplied offers.`,
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: summarizePayload(params.destination, params),
                },
              ],
            },
          ],
          text: { format: zodTextFormat(planOutputSchema, "plan") },
          signal,
        });

        const parsed = response.output_parsed;
        if (!parsed || typeof parsed !== "object") {
          lastError = "SCHEMA_PARSE";
          continue;
        }

        const tokens = response.usage;
        metrics.observe("llm_request_latency_ms", Date.now() - start, { model: this.options.modelName });
        await recordAgentRun({
          ctx,
          skillName: "plan.comparison",
          agentName: "shared",
          modelName: this.options.modelName,
          promptVersion: this.options.promptVersion,
          outputHash: hashOutput(parsed),
          latencyMs: Date.now() - start,
          status: "SUCCESS",
          tokens,
        });
        return parsed;
      } catch (err) {
        lastError = classifyError(err);
        if (lastError === "TIMEOUT") break;
      }
    }

    return fallbackToMock(lastError || "SCHEMA_PARSE");
  }

  async explainPlanDiff(params: {
    oldPlan: Record<string, unknown>;
    newPlan: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<PlanDiff> {
    return this.options.mock.explainPlanDiff({
      oldPlan: params.oldPlan,
      newPlan: params.newPlan,
      signal: params.signal,
    });
  }
}