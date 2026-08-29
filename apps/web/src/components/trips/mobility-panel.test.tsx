import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderWithIntl } from "@/test/render";
import { MobilityPanel } from "@/components/trips/mobility-panel";
import type { MobilityOffer } from "@/lib/api/contracts";

const BASE_OFFER: MobilityOffer = {
  offerId: "offer-1",
  serviceType: "TAXI",
  originPlaceId: "11111111-1111-4111-8111-111111111111",
  destinationPlaceId: "22222222-2222-4222-8222-222222222222",
  passengers: 2,
  departureAt: "2099-09-01T10:00:00.000Z",
  estimatedPrice: 45.5,
  currency: "USD",
  vehicleClass: "Sedan",
  estimated: true,
  expiresAt: "2099-09-01T11:00:00.000Z",
  source: "Amadeus Transfer Search",
  capturedAt: "2026-08-28T00:00:00.000Z",
};

describe("MobilityPanel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("returns null when no offers are present", () => {
    const { container } = renderWithIntl(<MobilityPanel offers={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders offer rows with price, vehicle, and service type", () => {
    renderWithIntl(<MobilityPanel offers={[BASE_OFFER]} />);
    expect(screen.getByText("Mobility offers")).toBeDefined();
    expect(screen.getByText(/Taxi · Sedan/)).toBeDefined();
    expect(screen.getByText(/45\.50 USD/)).toBeDefined();
    expect(screen.getByText(/2 passengers/)).toBeDefined();
  });

  it("filters by service type when the user picks a tab", () => {
    renderWithIntl(
      <MobilityPanel
        offers={[
          BASE_OFFER,
          { ...BASE_OFFER, offerId: "offer-2", serviceType: "CHARTER" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Charter" }));
    expect(screen.queryByText(/Taxi · Sedan/)).toBeNull();
    expect(screen.getByText(/Charter · Sedan/)).toBeDefined();
  });

  it("invokes onSelect with the offer payload", () => {
    const onSelect = vi.fn();
    renderWithIntl(<MobilityPanel offers={[BASE_OFFER]} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Select"));
    expect(onSelect).toHaveBeenCalledWith({ offer: BASE_OFFER });
  });

  it("invokes onDismiss with the offer id", () => {
    const onDismiss = vi.fn();
    renderWithIntl(<MobilityPanel offers={[BASE_OFFER]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onDismiss).toHaveBeenCalledWith("offer-1");
  });

  it("disables the select action for expired offers", () => {
    const expired: MobilityOffer = { ...BASE_OFFER, expiresAt: "2020-01-01T00:00:00.000Z" };
    const onSelect = vi.fn();
    renderWithIntl(<MobilityPanel offers={[expired]} onSelect={onSelect} />);
    expect(screen.getByText("Expired")).toBeDefined();
    fireEvent.click(screen.getByText("Select"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders localized labels in zh", () => {
    renderWithIntl(<MobilityPanel offers={[BASE_OFFER]} />, { locale: "zh" });
    expect(screen.getByText("出行报价")).toBeDefined();
    expect(screen.getByText(/出租车/)).toBeDefined();
  });
});