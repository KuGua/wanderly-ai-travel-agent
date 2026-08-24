import { dataModeSchema, type DataMode } from "./contracts";
import { FixtureTravelApi } from "./fixture-travel-api";
import { HttpTravelApi } from "./http-travel-api";
import type { TravelApi } from "./travel-api";

const DEFAULT_API_BASE_URL = "http://localhost:3000";

export interface TravelApiConfiguration {
  api: TravelApi;
  mode: DataMode;
}

export function createTravelApi(
  mode: DataMode,
  baseUrl = DEFAULT_API_BASE_URL,
  fetchImplementation?: typeof fetch,
  getAccessToken?: () => string | null,
): TravelApi {
  return mode === "fixture"
    ? new FixtureTravelApi()
    : new HttpTravelApi(baseUrl, fetchImplementation, getAccessToken);
}

export function getTravelApiConfiguration(): TravelApiConfiguration {
  const mode = dataModeSchema.parse(process.env.NEXT_PUBLIC_DATA_MODE ?? "fixture");
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  return { api: createTravelApi(mode, baseUrl), mode };
}

export type { TravelApi } from "./travel-api";
