import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";

afterEach(() => {
  cleanup();
});

import enMessages from "../../../messages/en.json";
import { QueryProvider } from "./provider";
import { TravelApi } from "../api";
import type { LocationIntroductionResponse } from "../api/contracts";
import { useLocationIntroduction } from "./use-location-introduction";

function makeWrapper(api: TravelApi) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QueryProvider configuration={{ api }}>{children}</QueryProvider>
      </NextIntlClientProvider>
    );
  };
}

function Probe({ sourceId, locale }: { sourceId: string | null; locale: "en" | "zh" }) {
  const state = useLocationIntroduction({ sourceId, locale });
  return (
    <div data-state={state.status} data-content={state.status === "ready" ? state.content : ""} data-cache={state.status === "ready" ? state.cacheStatus : ""}>
      {state.status}
    </div>
  );
}

const baseResponse: LocationIntroductionResponse = {
  status: "READY",
  content: "Tokyo is a city of contrasts.",
  cacheStatus: "HIT",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useLocationIntroduction", () => {
  it("returns idle when sourceId is null", () => {
    const api = { getLocationIntroduction: vi.fn() } as unknown as TravelApi;
    render(<Probe sourceId={null} locale="en" />, { wrapper: makeWrapper(api) });
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(api.getLocationIntroduction).not.toHaveBeenCalled();
  });

  it("transitions loading → ready on a HIT response", async () => {
    const api = { getLocationIntroduction: vi.fn().mockResolvedValue(baseResponse) } as unknown as TravelApi;
    render(<Probe sourceId="tokyo" locale="en" />, { wrapper: makeWrapper(api) });
    expect(await screen.findByText("ready")).toBeInTheDocument();
    const root = document.querySelector("[data-state]");
    expect(root?.getAttribute("data-cache")).toBe("HIT");
    expect(root?.getAttribute("data-content")).toBe(baseResponseContent());
  });

  it("transitions loading → ready on a MISS response and stops polling", async () => {
    const api = { getLocationIntroduction: vi.fn().mockResolvedValue({
      ...baseResponse,
      cacheStatus: "MISS",
    }) } as unknown as TravelApi;
    render(<Probe sourceId="paris" locale="en" />, { wrapper: makeWrapper(api) });
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    // Wait a bit to ensure no further fetches fire.
    await new Promise((r) => setTimeout(r, 750));
    expect(api.getLocationIntroduction).toHaveBeenCalledTimes(1);
  });

  it("polls while the server returns 202 GENERATING and stops when it returns READY", async () => {
    let invocations = 0;
    const api = { getLocationIntroduction: vi.fn().mockImplementation(async () => {
      invocations += 1;
      if (invocations < 3) {
        return { status: "GENERATING", retryAfterMs: 500 };
      }
      return baseResponse;
    }) } as unknown as TravelApi;
    render(<Probe sourceId="lisbon" locale="en" />, { wrapper: makeWrapper(api) });
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument(), { timeout: 4_000 });
    expect(api.getLocationIntroduction).toHaveBeenCalledTimes(3);
  });

  it("maps a 503 error to the unavailable state", async () => {
    const api = { getLocationIntroduction: vi.fn().mockRejectedValue(new Error("LOCATION_INTRODUCTION_UNAVAILABLE: temp")) } as unknown as TravelApi;
    render(<Probe sourceId="newyork" locale="en" />, { wrapper: makeWrapper(api) });
    await waitFor(() => expect(screen.getByText("unavailable")).toBeInTheDocument());
    expect(api.getLocationIntroduction).toHaveBeenCalledTimes(1);
  });

  it("uses locale from the request body, not from the browser", async () => {
    const api = { getLocationIntroduction: vi.fn().mockResolvedValue(baseResponse) } as unknown as TravelApi;
    render(<Probe sourceId="tokyo" locale="zh" />, { wrapper: makeWrapper(api) });
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
    expect(api.getLocationIntroduction).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "tokyo", locale: "zh" }),
    );
  });
});

function baseResponseContent() {
  return baseResponse.status === "READY" ? baseResponse.content : "";
}