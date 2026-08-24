import type { ZodType } from "zod";

import { apiErrorResponseSchema } from "./contracts";
import { TravelApiError } from "./errors";

type FetchImplementation = typeof fetch;

export class ApiClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly getAccessToken: () => string | null = () => null,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request<T>(
    path: string,
    schema: ZodType<T>,
    options: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    const accessToken = this.getAccessToken();

    if (accessToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    if (options.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
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
