import {
  profileResponseSchema,
  tripsResponseSchema,
  updateProfileInputSchema,
  updateProfileResponseSchema,
  type ProfileResponse,
  type UpdateProfileInput,
} from "./contracts";
import { TravelApiError } from "./errors";
import type { TravelApi } from "./travel-api";
import { fixtureProfile } from "@/lib/fixtures/profiles";
import { fixtureTrips } from "@/lib/fixtures/trips";

export class FixtureTravelApi implements TravelApi {
  private profile: ProfileResponse = structuredClone(fixtureProfile);

  async getMyProfile() {
    return profileResponseSchema.parse(structuredClone(this.profile));
  }

  async updateMyProfile(input: UpdateProfileInput) {
    const body = updateProfileInputSchema.parse(input);
    const current = this.profile.profile;
    if (!current) {
      throw new TravelApiError(
        "Profile not found",
        404,
        "Not Found",
        "55555555-5555-4555-8555-555555555555",
      );
    }

    const profile = profileResponseSchema.parse({
      profile: {
        ...current,
        ...body,
        updatedAt: new Date().toISOString(),
      },
    });
    this.profile = profile;

    return updateProfileResponseSchema.parse({
      message: "Profile updated",
      profile: profile.profile,
    });
  }

  async getTrips() {
    return tripsResponseSchema.parse(structuredClone(fixtureTrips));
  }
}
