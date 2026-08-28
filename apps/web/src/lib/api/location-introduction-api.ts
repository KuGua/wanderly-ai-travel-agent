import { ApiClient } from "./client";
import {
  apiErrorResponseSchema,
  locationIntroductionGeneratingSchema,
  locationIntroductionInputSchema,
  locationIntroductionReadySchema,
  type LocationIntroductionInput,
  type LocationIntroductionResponse,
} from "./contracts";
import { TravelApiError } from "./errors";

/**
 * Anonymous POST to `/explore/location-introductions`. Unlike the other
 * `ApiClient.request` paths, this endpoint has two success-shaped
 * responses: 200 READY and 202 GENERATING. The caller wants the
 * discriminated union so the hook can poll on GENERATING and stop on
 * READY. Errors follow the standard `errorResponseSchema` envelope.
 *
 * No retry / no exponential backoff: the server's 7-day cache makes a
 * second retry unnecessary, and the 202 path already gives the caller a
 * `retryAfterMs` to honor.
 */
export async function fetchLocationIntroduction(
  client: ApiClient,
  input: LocationIntroductionInput,
): Promise<LocationIntroductionResponse> {
  // Validate input client-side before the request to avoid a wasted
  // round-trip on obviously bad payloads.
  const parsedInput = locationIntroductionInputSchema.parse(input);

  // We bypass `client.request` because the response is a 200/202
  // union rather than a single schema. Headers (auth, correlation,
  // request-id) still flow through the shared client.
  const headers = new Headers({ "Content-Type": "application/json" });
  const url = "/explore/location-introductions";

  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(parsedInput),
  };

  // `client.request` would also work for the READY path, but it would
  // throw on 202. We use the shared client only to keep the
  // auth / correlation / request-id wiring identical.
  return await rawLocationIntroductionRequest(client, url, init);
}

async function rawLocationIntroductionRequest(
  client: ApiClient,
  url: string,
  init: RequestInit,
): Promise<LocationIntroductionResponse> {
  // Reuse the shared client implementation by calling the same fetch
  // path but branching on status. Pull the implementation details out
  // of `ApiClient` to avoid duplicating the auth header logic.
  const internal = client as unknown as {
    baseUrl: string;
    fetchImplementation: typeof fetch;
    getAccessToken: () => string | null | Promise<string | null>;
    lastCorrelationId: string | null;
  };
  const fullUrl = `${internal.baseUrl}${url.startsWith("/") ? url : `/${url}`}`;
  const headers = new Headers(init.headers);
  const accessToken = await internal.getAccessToken();
  if (accessToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }
  if (!headers.has("X-Request-Id")) headers.set("X-Request-Id", cryptoRandomUuid());
  if (!headers.has("X-Correlation-Id")) {
    headers.set("X-Correlation-Id", internal.lastCorrelationId ?? headers.get("X-Request-Id") ?? "");
  }
  let response: Response;
  try {
    response = await internal.fetchImplementation(fullUrl, { ...init, headers });
  } catch (cause) {
    throw new TravelApiError(
      "The travel service is unreachable. Check the API and try again.",
      null,
      "Network Error",
      null,
      { cause },
    );
  }
  const responseCorrelationId = response.headers.get("x-correlation-id");
  if (responseCorrelationId) {
    (internal as unknown as { lastCorrelationId: string | null }).lastCorrelationId = responseCorrelationId;
  }

  const body = await response.text();
  const parsedBody = body ? safeJsonParse(body) : undefined;

  if (response.status === 200) {
    const ready = locationIntroductionReadySchema.safeParse(parsedBody);
    if (!ready.success) {
      throw new TravelApiError(
        "The travel service returned an unexpected response.",
        response.status,
        "Invalid Response",
        responseCorrelationId,
        { cause: ready.error },
      );
    }
    return ready.data;
  }

  if (response.status === 202) {
    const generating = locationIntroductionGeneratingSchema.safeParse(parsedBody);
    if (!generating.success) {
      throw new TravelApiError(
        "The travel service returned an unexpected response.",
        response.status,
        "Invalid Response",
        responseCorrelationId,
        { cause: generating.error },
      );
    }
    return generating.data;
  }

  const errParsed = apiErrorResponseSchema.safeParse(parsedBody);
  if (errParsed.success) {
    throw new TravelApiError(
      errParsed.data.message,
      errParsed.data.statusCode,
      errParsed.data.error,
      errParsed.data.correlationId,
    );
  }

  throw new TravelApiError(
    response.statusText || `Request failed with status ${response.status}`,
    response.status,
    "Request Error",
    responseCorrelationId,
  );
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function cryptoRandomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}