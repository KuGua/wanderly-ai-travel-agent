import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import { HotelOfferCard } from "@/components/trips/hotel-offer-card";
import type { HotelOfferDto } from "@/lib/api/contracts";
import enMessages from "../../../messages/en.json";

afterEach(() => cleanup());

const baseOffer: HotelOfferDto = {
  id: "00000000-0000-0000-0000-000000000001",
  providerOfferId: "offer-1",
  queryId: "00000000-0000-0000-0000-000000000002",
  providerName: "serpapi_google_hotels",
  destinationId: "Tokyo",
  propertyId: "p1",
  propertyName: "Park Hotel Tokyo",
  checkIn: "2026-09-15",
  checkOut: "2026-09-18",
  nights: 3,
  roomCount: 1,
  adultsPerRoom: [2],
  totalPrice: 360,
  pricePerNight: 120,
  currency: "USD",
  taxesAndFees: { status: "INCLUDED", amount: 60 },
  cancellationSummary: "Free cancellation available",
  roomSummary: "4-star · Pool, Wi-Fi",
  source: "SerpApi Google Hotels",
  capturedAt: "2026-08-30T10:00:00.000Z",
  expiresAt: "2026-08-30T10:15:00.000Z",
};

function renderWithIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe("HotelOfferCard", () => {
  it("renders provider source and excludes supplier-only fields", () => {
    renderWithIntl(<HotelOfferCard offer={baseOffer} />);
    expect(screen.getByText(/SerpApi Google Hotels/i)).toBeTruthy();
    expect(screen.getByText("Park Hotel Tokyo")).toBeTruthy();
    expect(screen.getByTestId("hotel-offer-card").getAttribute("data-provider")).toBe("serpapi_google_hotels");
    // No supplier URL, address, or image rendered.
    expect(screen.queryByText(/http/i)).toBeNull();
  });

  it("shows 'taxes may apply' disclaimer for PARTIAL and UNKNOWN status", () => {
    const partial = { ...baseOffer, taxesAndFees: { status: "PARTIAL" as const, amount: 30 } };
    renderWithIntl(<HotelOfferCard offer={partial} />);
    expect(screen.getByTestId("hotel-tax-disclaimer")).toBeTruthy();
  });

  it("hides disclaimer when status is INCLUDED", () => {
    renderWithIntl(<HotelOfferCard offer={baseOffer} />);
    expect(screen.queryByTestId("hotel-tax-disclaimer")).toBeNull();
  });

  it("renders Nuitee source without exposing nationality or rateId", () => {
    const nuiteeOffer: HotelOfferDto = {
      ...baseOffer,
      providerName: "nuitee_connect",
      source: "Nuitee LiteAPI Rates",
      propertyName: "Nuitee Tokyo",
      cancellationSummary: null,
    };
    renderWithIntl(<HotelOfferCard offer={nuiteeOffer} />);
    expect(screen.getByText(/Nuitee LiteAPI Rates/i)).toBeTruthy();
    expect(screen.getByText("Nuitee Tokyo")).toBeTruthy();
    expect(screen.getByTestId("hotel-offer-card").getAttribute("data-provider")).toBe("nuitee_connect");
  });
});
