import type { ZodType } from "zod";

import { apiErrorResponseSchema } from "./contracts";
import { TravelApiError } from "./errors";
import {
  actionForApiRequest,
  createUiDiagnosticReporter,
  errorCategoryFor,
  getCurrentUiScreen,
  type UiDiagnosticEvent,
} from "@/lib/observability/ui-diagnostics";

type FetchImplementation = typeof fetch;
export type GetAccessToken = () => string | null | Promise<string | null>;

function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC4122 v4 fallback for environments without crypto.randomUUID
  // (very old browsers and certain Node versions without globalThis.crypto).
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ApiClient {
  private readonly baseUrl: string;
  private lastCorrelationId: string | null = null;

  constructor(
    baseUrl: string,
    private readonly fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis),
    private readonly getAccessToken: GetAccessToken = () => null,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request<T>(
    path: string,
    schema: ZodType<T>,
    options: RequestInit = {},
  ): Promise<T> {
    const startedAt = performance.now();
    const headers = new Headers(options.headers);
    const accessToken = await this.getAccessToken();

    if (accessToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    // Attach a fresh request id and the most recent server-issued correlation
    // id (if any) so the backend can chain logs across the client session.
    const requestId = generateRequestId();
    if (!headers.has("X-Request-Id")) headers.set("X-Request-Id", requestId);
    if (!headers.has("X-Correlation-Id")) {
      headers.set("X-Correlation-Id", this.lastCorrelationId ?? requestId);
    }
    const diagnostic = createUiDiagnosticReporter({
      apiBaseUrl: this.baseUrl,
      getAccessToken: this.getAccessToken,
    });
    const report = (event: Omit<UiDiagnosticEvent, "eventType" | "action" | "screen" | "durationMs" | "relatedClientRequestId">) => {
      const action = actionForApiRequest(path, options.method ?? "GET");
      if (!action) return;
      void diagnostic.send({
        eventType: "ui_api_request",
        action,
        screen: getCurrentUiScreen(),
        durationMs: Math.round(performance.now() - startedAt),
        relatedClientRequestId: requestId,
        ...event,
      }, accessToken);
    };

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`,
        { ...options, headers },
      );
    } catch (cause) {
      const error = new TravelApiError(
        "The travel service is unreachable. Check the API and try again.",
        null,
        "Network Error",
        null,
        { cause },
      );
      report({ outcome: "failure", errorCategory: errorCategoryFor(error) });
      throw error;
    }

    // Remember the server-issued correlation id for the next request in
    // this session. The server always echoes `x-correlation-id`, even on
    // errors; this gives support staff a single thread across requests.
    const responseCorrelationId = response.headers.get("x-correlation-id");
    if (responseCorrelationId) {
      this.lastCorrelationId = responseCorrelationId;
    }

    const body = await readResponseBody(response);
    if (!response.ok) {
      const parsedError = apiErrorResponseSchema.safeParse(body);
      if (parsedError.success) {
        const error = new TravelApiError(
          parsedError.data.message,
          parsedError.data.statusCode,
          parsedError.data.error,
          parsedError.data.correlationId,
        );
        report({
          outcome: "failure", errorCategory: errorCategoryFor(error), httpStatus: response.status,
          relatedCorrelationId: parsedError.data.correlationId,
        });
        throw error;
      }

      const error = new TravelApiError(
        response.statusText || `Request failed with status ${response.status}`,
        response.status,
        "Request Error",
        response.headers.get("x-correlation-id"),
      );
      report({
        outcome: "failure", errorCategory: errorCategoryFor(error), httpStatus: response.status,
        relatedCorrelationId: error.correlationId ?? undefined,
      });
      throw error;
    }

    const parsedBody = schema.safeParse(body);
    if (!parsedBody.success) {
      const error = new TravelApiError(
        "The travel service returned an unexpected response.",
        response.status,
        "Invalid Response",
        response.headers.get("x-correlation-id"),
        { cause: parsedBody.error },
      );
      report({
        outcome: "failure", errorCategory: errorCategoryFor(error), httpStatus: response.status,
        relatedCorrelationId: error.correlationId ?? undefined,
      });
      throw error;
    }

    report({
      outcome: "success", errorCategory: "none", httpStatus: response.status,
      relatedCorrelationId: responseCorrelationId ?? undefined,
    });
    return parsedBody.data;
  }

  async stream(
    path: string,
    signal: AbortSignal,
    onEvent: (eventName: string, data: unknown) => void,
  ): Promise<void> {
    const headers = new Headers({ Accept: "text/event-stream" });
    const accessToken = await this.getAccessToken();
    if (accessToken) headers.set("Authorization", "Bearer " + accessToken);
    const requestId = generateRequestId();
    headers.set("X-Request-Id", requestId);
    headers.set("X-Correlation-Id", this.lastCorrelationId ?? requestId);

    let response: Response;
    try {
      response = await this.fetchImplementation(
        this.baseUrl + (path.startsWith("/") ? path : "/" + path),
        { method: "GET", headers, signal },
      );
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new TravelApiError(
        "The Agent stream is unreachable. The accepted task will continue.",
        null,
        "Network Error",
        null,
        { cause },
      );
    }

    const responseCorrelationId = response.headers.get("x-correlation-id");
    if (responseCorrelationId) this.lastCorrelationId = responseCorrelationId;

    if (!response.ok) {
      const body = await readResponseBody(response);
      const parsedError = apiErrorResponseSchema.safeParse(body);
      throw new TravelApiError(
        parsedError.success ? parsedError.data.message : "Unable to subscribe to the Agent stream.",
        response.status,
        parsedError.success ? parsedError.data.error : "Stream Error",
        response.headers.get("x-correlation-id"),
      );
    }
    if (!response.body) {
      throw new TravelApiError("The Agent stream returned no body.", response.status, "Stream Error", null);
    }
    await consumeEventStream(response.body, onEvent);
  }

  /**
   * Test-only helper. Resets the last-seen correlation id; used by
   * `http-travel-api.test.ts` to assert that the chain restarts cleanly
   * when a fresh client is created.
   */
  __resetCorrelationIdForTests(): void {
    this.lastCorrelationId = null;
  }
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventName: string, data: unknown) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = eventBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        parseEventBlock(block, onEvent);
        boundary = eventBoundary(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function eventBoundary(buffer: string): { index: number; length: number } | null {
  const unix = buffer.indexOf("\n\n");
  const windows = buffer.indexOf("\r\n\r\n");
  if (unix < 0 && windows < 0) return null;
  if (windows >= 0 && (unix < 0 || windows < unix)) return { index: windows, length: 4 };
  return { index: unix, length: 2 };
}

function parseEventBlock(block: string, onEvent: (eventName: string, data: unknown) => void) {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/u)) {
    if (rawLine.startsWith(":")) continue;
    if (rawLine.startsWith("event:")) eventName = rawLine.slice(6).trim();
    if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).trimStart());
  }
  if (dataLines.length === 0) return;
  try {
    onEvent(eventName, JSON.parse(dataLines.join("\n")));
  } catch {
    // Invalid or partial event payloads are ignored. Durable run state remains
    // authoritative and the caller will recover it through the read endpoint.
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
