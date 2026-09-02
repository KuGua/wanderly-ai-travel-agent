import { HttpTravelApi } from "./http-travel-api";
import type { GetAccessToken } from "./client";
import type { TravelApi } from "./travel-api";

const DEFAULT_API_BASE_URL = "http://localhost:3000";

export interface TravelApiConfiguration {
  api: TravelApi;
}

/**
 * The API server's address. `NEXT_PUBLIC_API_BASE_URL`, when set, always
 * wins — that's how a real deployment points at its own fixed backend.
 *
 * Unset (the local-LAN dev case), this follows whatever address the page
 * itself was loaded from. A laptop's LAN IP changes every time it joins a
 * new Wi-Fi network, and hardcoding one meant every device on the network
 * silently broke the moment that network changed — the page would still
 * load (it isn't the same address as the API call), but every request
 * hung forever against an address the laptop no longer owned. A phone or
 * another laptop that opened this page via the *current* LAN address is
 * necessarily able to reach that same address on the API's port, so this
 * needs no configuration at all, on any device, ever again.
 */
export function resolveApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined") return `${window.location.protocol}//${window.location.hostname}:3000`;
  return DEFAULT_API_BASE_URL;
}

export function createTravelApi(
  baseUrl = DEFAULT_API_BASE_URL,
  fetchImplementation?: typeof fetch,
  getAccessToken?: GetAccessToken,
): TravelApi {
  return new HttpTravelApi(baseUrl, fetchImplementation, getAccessToken);
}

export function getTravelApiConfiguration(getAccessToken?: GetAccessToken): TravelApiConfiguration {
  return { api: createTravelApi(resolveApiBaseUrl(), undefined, getAccessToken) };
}

export type { TravelApi } from "./travel-api";
export type { ExplorationStartResponse } from "./contracts";
