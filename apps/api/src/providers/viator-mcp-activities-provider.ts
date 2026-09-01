import { randomUUID } from "node:crypto";

import { metrics } from "../observability/metrics.js";
import type {
  ActivitiesProvider,
  ActivitiesSearchParams,
  ActivityProviderItem,
  ProviderResult,
} from "./types.js";
import {
  viatorMcpResponseSchema,
  viatorExperienceSchema,
  viatorSearchStructuredContentSchema,
} from "./viator-mcp-activities-schemas.js";

const DEFAULT_MCP_URL = "https://exp-app-mcp.prod.ep.viator.com/mcp";
const SOURCE = "Viator Experiences MCP";

export interface ViatorMcpActivitiesProviderOptions {
  endpoint: string;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

type UnavailableReason = Extract<ProviderResult<never>, { outcome: "UNAVAILABLE" }>["reason"];
type ProviderAttempt = ProviderResult<ActivityProviderItem[]> & { retryAfterMs?: number };

export function readViatorMcpConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ViatorMcpActivitiesProviderOptions | null {
  if (env.VIATOR_MCP_ENABLED !== "true") return null;
  const endpoint = env.VIATOR_MCP_URL?.trim() || DEFAULT_MCP_URL;
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:") throw new Error("VIATOR_MCP_URL must use HTTPS");
  const timeoutMs = parseBoundedInteger(env.VIATOR_MCP_TIMEOUT_MS, 8_000, 500, 30_000, "VIATOR_MCP_TIMEOUT_MS");
  const maxRetries = parseBoundedInteger(env.VIATOR_MCP_MAX_RETRIES, 1, 0, 2, "VIATOR_MCP_MAX_RETRIES");
  return { endpoint, timeoutMs, maxRetries };
}

export class ViatorMcpActivitiesProvider implements ActivitiesProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: ViatorMcpActivitiesProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async searchActivities(
    params: ActivitiesSearchParams,
  ): Promise<ProviderResult<ActivityProviderItem[]>> {
    const startedAt = Date.now();
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    let lastReason: UnavailableReason = "UPSTREAM_FAILURE";
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const response = await this.callSearch(params);
        if (response.outcome === "LIVE") {
          return this.record(response, startedAt);
        }
        lastReason = response.reason;
        if (response.reason === "RATE_LIMITED" && response.retryAfterMs !== undefined
          && response.retryAfterMs <= 5_000 && attempt < this.options.maxRetries) {
          await delay(response.retryAfterMs, params.signal);
          continue;
        }
        if (!isRetryable(response.reason) || attempt === this.options.maxRetries) {
          return this.record({ outcome: "UNAVAILABLE", reason: response.reason }, startedAt);
        }
        await delay(250 * 2 ** attempt, params.signal);
      } catch (error) {
        if (params.signal?.aborted) {
          throw params.signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        lastReason = (error as { name?: string }).name === "AbortError"
          ? "UPSTREAM_TIMEOUT"
          : "UPSTREAM_FAILURE";
        if (attempt === this.options.maxRetries) {
          return this.record({ outcome: "UNAVAILABLE", reason: lastReason }, startedAt);
        }
      }
    }
    return this.record({ outcome: "UNAVAILABLE", reason: lastReason }, startedAt);
  }

  private async callSearch(
    params: ActivitiesSearchParams,
  ): Promise<ProviderAttempt> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(params.signal?.reason);
    if (params.signal?.aborted) abortFromCaller();
    else params.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(new DOMException("Timed out", "AbortError")), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: {
            name: "search_experiences",
            arguments: {
              searchTerm: controlledSearchTerm(params),
              startDate: params.dateStart,
              endDate: params.dateEnd,
              limit: params.limit,
              // Without this the response's `fromPrice` has no stated
              // denomination and the amount is unusable — which is why prices
              // were previously discarded outright.
              currency: params.currency,
              sessionId: randomUUID(),
            },
          },
        }),
        signal: controller.signal,
      });
      if (response.status === 429) return {
        outcome: "UNAVAILABLE",
        reason: "RATE_LIMITED",
        ...(retryAfterMs(response.headers.get("retry-after")) !== null
          ? { retryAfterMs: retryAfterMs(response.headers.get("retry-after"))! }
          : {}),
      };
      if (response.status === 401 || response.status === 403) {
        return { outcome: "UNAVAILABLE", reason: "PROVIDER_NOT_APPROVED" };
      }
      if (response.status >= 500) return { outcome: "UNAVAILABLE", reason: "UPSTREAM_FAILURE" };
      if (!response.ok) return { outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" };

      const rawText = await response.text();
      if (rawText.length > 1_000_000) {
        return { outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" };
      }
      const protocolPayload = parseMcpPayload(rawText, response.headers.get("content-type"));
      const envelope = viatorMcpResponseSchema.safeParse(protocolPayload);
      if (!envelope.success) return { outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" };
      if (envelope.data.error) {
        const resetMs = retryAfterFromMessage(envelope.data.error.message);
        return {
          outcome: "UNAVAILABLE",
          reason: /rate limit/i.test(envelope.data.error.message) ? "RATE_LIMITED" : "UPSTREAM_FAILURE",
          ...(resetMs === null ? {} : { retryAfterMs: resetMs }),
        };
      }
      if (envelope.data.result?.isError) {
        const text = envelope.data.result.content?.map((part) => part.text ?? "").join(" ") ?? "";
        const resetMs = retryAfterFromMessage(text);
        return {
          outcome: "UNAVAILABLE",
          reason: /rate limit/i.test(text) ? "RATE_LIMITED" : "UPSTREAM_FAILURE",
          ...(resetMs === null ? {} : { retryAfterMs: resetMs }),
        };
      }
      const structured = viatorSearchStructuredContentSchema.safeParse(
        envelope.data.result?.structuredContent,
      );
      if (!structured.success) return { outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" };
      if (structured.data.experiences.length === 0) return { outcome: "UNAVAILABLE", reason: "NO_RESULTS" };

      // Validate one experience at a time. A single malformed entry is the
      // supplier's problem with that entry, not grounds for discarding the
      // page — the owner would see "unavailable" while usable results sat in
      // the response. If nothing survives, that is genuine schema drift.
      const experiences = structured.data.experiences
        .map((raw) => viatorExperienceSchema.safeParse(raw))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data);
      if (experiences.length === 0) return { outcome: "UNAVAILABLE", reason: "INVALID_PROVIDER_RESPONSE" };

      return {
        outcome: "LIVE",
        source: SOURCE,
        capturedAt: this.now().toISOString(),
        data: experiences
          .filter((experience) => matchesDestination(experience.clickOffToLander, params.destination))
          .map((experience) => ({
          providerOfferId: experience.code,
          title: experience.title,
          thumbnailUrl: experience.thumbnail,
          rating: experience.rating ?? null,
          reviewCount: experience.reviewCount ?? 0,
          freeCancellation: experience.freeCancellation,
          durationMinutes: {
            fixed: experience.duration?.fixedDurationInMinutes ?? null,
            from: experience.duration?.variableDurationFromMinutes ?? null,
            to: experience.duration?.variableDurationToMinutes ?? null,
          },
          category: experience.keyAttributes?.mainCategory ?? null,
          fromPrice: experience.fromPrice,
          currency: params.currency,
          providerLocality: localityFromLander(experience.clickOffToLander),
        })),
      };
    } finally {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private record<T extends ProviderResult<ActivityProviderItem[]>>(result: T, startedAt: number): T {
    const outcome = result.outcome === "LIVE" ? "live" : "unavailable";
    const errorCategory = result.outcome === "LIVE" ? "none" : result.reason.toLowerCase();
    metrics.inc("activities_provider_requests_total", {
      outcome,
      provider: "viator_mcp",
      error_category: errorCategory,
    });
    metrics.observe("activities_provider_latency_ms", Date.now() - startedAt, {
      provider: "viator_mcp",
      outcome,
    });
    return result;
  }
}

function controlledSearchTerm(params: ActivitiesSearchParams): string {
  const theme = params.theme ? {
    CULTURE: "cultural experiences",
    FOOD: "food experiences",
    OUTDOOR: "outdoor experiences",
    FAMILY: "family-friendly experiences",
  }[params.theme] : "things to do";
  // Destination is already snapshot-bound by the service. Keeping the query
  // construction here prevents models and browsers from supplying free text.
  return `${theme} in ${params.destination}`;
}

/**
 * Recovers the destination the provider filed a product under, from its product
 * URL (`.../tours/<Locality>/<slug>`).
 *
 * This is the only geographic signal in the response: there is no country,
 * coordinate or destination field. The URL itself is discarded before anything
 * leaves this adapter — it is a booking link — but it is read first, because
 * otherwise nothing can tell whether a result belongs to the trip at all.
 */
export function localityFromLander(lander: string): string | null {
  const match = /\/tours\/([^/]+)\//.exec(lander);
  if (!match) return null;
  return decodeURIComponent(match[1]).replace(/-/g, " ").trim() || null;
}

/**
 * Whether a product belongs to the requested destination.
 *
 * A search for Tokyo returns products in Rio de Janeiro and Anaheim: the
 * provider matches on text, and adding a country to the query does not change
 * that. Comparison is by name only, so it cannot separate two places that share
 * one (Cambridge UK from Cambridge MA) — it removes results from an entirely
 * different destination, which is the common case.
 *
 * A product whose URL carries no locality is kept: the check exists to remove
 * results that are demonstrably elsewhere, not to require proof of belonging.
 */
export function matchesDestination(lander: string, destination: string): boolean {
  const locality = localityFromLander(lander);
  if (!locality) return true;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const a = normalize(locality);
  const b = normalize(destination);
  return a.includes(b) || b.includes(a);
}

function parseMcpPayload(body: string, contentType: string | null): unknown {
  if (contentType?.includes("text/event-stream")) {
    const data = body.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .find((line) => line && line !== "[DONE]");
    if (!data) throw new Error("MCP stream contained no data event");
    return JSON.parse(data) as unknown;
  }
  return JSON.parse(body) as unknown;
}

function isRetryable(reason: UnavailableReason): boolean {
  // A 429 is surfaced immediately instead of retrying without a provider-
  // supplied reset window. This avoids amplifying pressure on a public MCP.
  return reason === "UPSTREAM_TIMEOUT" || reason === "UPSTREAM_FAILURE";
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : null;
}

function retryAfterFromMessage(message: string): number | null {
  const match = message.match(/retry after\s+(\d+(?:\.\d+)?)\s+seconds?/i);
  return match ? Math.ceil(Number(match[1]) * 1_000) : null;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}
