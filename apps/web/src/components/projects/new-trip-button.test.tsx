import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TravelApi } from "@/lib/api";
import { renderWithIntl } from "@/test/render";
import { NewTripButton } from "./new-trip-button";

const push = vi.hoisted(() => vi.fn());
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("creates once and opens the returned workspace", async () => {
  const startExploration = vi.fn().mockResolvedValue({ trip: { id: "new" }, defaultThread: { id: "thread" } });
  renderWithIntl(<NewTripButton />, { api: { startExploration } as unknown as TravelApi });
  const button = screen.getByRole("button", { name: "New trip" });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(push).toHaveBeenCalledWith("/trips/new?thread=thread"));
  expect(startExploration).toHaveBeenCalledOnce();
});

it("reuses the same request ID after failure", async () => {
  const startExploration = vi.fn().mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue({ trip: { id: "new" }, defaultThread: { id: "thread" } });
  renderWithIntl(<NewTripButton />, { api: { startExploration } as unknown as TravelApi });
  fireEvent.click(screen.getByRole("button", { name: "New trip" }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "New trip" }));
  await waitFor(() => expect(push).toHaveBeenCalled());
  expect(startExploration.mock.calls[0][0].requestId).toBe(startExploration.mock.calls[1][0].requestId);
});
