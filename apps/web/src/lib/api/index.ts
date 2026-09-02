import { HttpTravelApi } from "./http-travel-api";
import type { GetAccessToken } from "./client";
import type { TravelApi } from "./travel-api";

const DEFAULT_API_BASE_URL = "http://localhost:3000";

export interface TravelApiConfiguration {
  api: TravelApi;
}

export function createTravelApi(
  baseUrl = DEFAULT_API_BASE_URL,
  fetchImplementation?: typeof fetch,
  getAccessToken?: GetAccessToken,
): TravelApi {
  return new HttpTravelApi(baseUrl, fetchImplementation, getAccessToken);
}

export function getTravelApiConfiguration(getAccessToken?: GetAccessToken): TravelApiConfiguration {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  return { api: createTravelApi(baseUrl, undefined, getAccessToken) };
}

export type { TravelApi } from "./travel-api";
export type { ExplorationStartResponse } from "./contracts";
