import { ApiClient } from "./client";
import {
  profileResponseSchema,
  tripsResponseSchema,
  updateProfileInputSchema,
  updateProfileResponseSchema,
  locationReferenceInputSchema,
  locationReferenceResponseSchema,
  type UpdateProfileInput,
} from "./contracts";
import type { TravelApi } from "./travel-api";

export class HttpTravelApi implements TravelApi {
  private readonly client: ApiClient;

  constructor(baseUrl: string, fetchImplementation?: typeof fetch, getAccessToken?: () => string | null) {
    this.client = new ApiClient(`${baseUrl.replace(/\/$/, "")}/api/v1`, fetchImplementation, getAccessToken);
  }

  getMyProfile() {
    return this.client.request("/profiles/me", profileResponseSchema);
  }

  updateMyProfile(input: UpdateProfileInput) {
    const body = updateProfileInputSchema.parse(input);
    return this.client.request("/profiles/me", updateProfileResponseSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  getTrips() {
    return this.client.request("/trips", tripsResponseSchema);
  }

  getLocationReference(input: import("./contracts").LocationReferenceInput) {
    const body = locationReferenceInputSchema.parse(input);
    return this.client.request("/explore/location-reference", locationReferenceResponseSchema, {
      method: "POST", body: JSON.stringify(body),
    });
  }
}
