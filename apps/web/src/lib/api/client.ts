import type { ZodType } from "zod";

import { apiErrorResponseSchema } from "./contracts";
import { TravelApiError } from "./errors";

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

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`,
        { ...options, headers },
      );
    } catch (cause) {
      throw new TravelApiError(
        "The travel service is unreachable. Check the API and try again.",
        null,
        "Network Error",
        null,
        { cause },
      );
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
        throw new TravelApiError(
          parsedError.data.message,
          parsedError.data.statusCode,
          parsedError.data.error,
          parsedError.data.correlationId,
        );
      }

      throw new TravelApiError(
        response.statusText || `Request failed with status ${response.status}`,
        response.status,
        "Request Error",
        response.headers.get("x-correlation-id"),
      );
    }

    const parsedBody = schema.safeParse(body);
    if (!parsedBody.success) {
      throw new TravelApiError(
        "The travel service returned an unexpected response.",
        response.status,
        "Invalid Response",
        response.headers.get("x-correlation-id"),
        { cause: parsedBody.error },
      );
    }

    return parsedBody.data;
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
