import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock("@/i18n/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n/navigation")>();
  return { ...actual, useRouter: () => ({ push: routerPush }) };
});

import { HomeDashboard } from "./home-dashboard";

const TRIP_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  cleanup();
  routerPush.mockReset();
});

describe("HomeDashboard", () => {
  it("creates an idempotent Draft trip and opens its planning workspace", async () => {
    const startExploration = vi.fn().mockResolvedValue({
      trip: {
        id: TRIP_ID,
        name: "Trip Planner",
        status: "DRAFT",
        departureCities: [],
        destinationCandidates: [],
        travelDateStart: null,
        travelDateEnd: null,
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:00:00.000Z",
      },
      defaultThread: { id: THREAD_ID, tripId: TRIP_ID, scope: "TRIP", isDefault: true },
    });
    const api = {
      getMyProfile: vi.fn().mockResolvedValue({ profile: null }),
      getTrips: vi.fn().mockResolvedValue({ trips: [], nextCursor: null }),
      startExploration,
    } as unknown as TravelApi;

    renderWithIntl(<HomeDashboard />, { api });
    fireEvent.click(screen.getByRole("button", { name: "New trip" }));

    await waitFor(() => expect(startExploration).toHaveBeenCalledTimes(1));
    expect(startExploration.mock.calls[0][0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith(`/trips/${TRIP_ID}?thread=${THREAD_ID}`));
  });
});
