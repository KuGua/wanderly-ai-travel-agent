import type {
  ProfileResponse,
  TripsResponse,
  UpdateProfileInput,
  UpdateProfileResponse,
} from "./contracts";

export interface TravelApi {
  getMyProfile(): Promise<ProfileResponse>;
  updateMyProfile(input: UpdateProfileInput): Promise<UpdateProfileResponse>;
  getTrips(): Promise<TripsResponse>;
}
