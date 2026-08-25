import type {
  ProfileResponse,
  TripsResponse,
  UpdateProfileInput,
  UpdateProfileResponse,
  LocationReferenceInput,
  LocationReferenceResponse,
} from "./contracts";

export interface TravelApi {
  getMyProfile(): Promise<ProfileResponse>;
  updateMyProfile(input: UpdateProfileInput): Promise<UpdateProfileResponse>;
  getTrips(): Promise<TripsResponse>;
  getLocationReference(input: LocationReferenceInput): Promise<LocationReferenceResponse>;
}
