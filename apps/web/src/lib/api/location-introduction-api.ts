import { ApiClient } from "./client";
import {
  locationIntroductionInputSchema,
  locationIntroductionResponseSchema,
  type LocationIntroductionInput,
  type LocationIntroductionResponse,
} from "./contracts";

/**
 * The standard ApiClient accepts every 2xx response, including the 202
 * generation state, and retains shared auth/correlation handling.
 */
export async function fetchLocationIntroduction(
  client: ApiClient,
  input: LocationIntroductionInput,
  options: { signal?: AbortSignal } = {},
): Promise<LocationIntroductionResponse> {
  const body = locationIntroductionInputSchema.parse(input);
  return client.request("/explore/location-introductions", locationIntroductionResponseSchema, {
    method: "POST",
    body: JSON.stringify(body),
    signal: options.signal,
  });
}
