import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import { FlightOfferCard } from "@/components/trips/flight-offer-card";
import type { ConversationFlightOffer } from "@/lib/api/contracts";
import enMessages from "../../../messages/en.json";

afterEach(() => cleanup());

const nonstopOffer: ConversationFlightOffer = {
  carrierCode: "ZG",
  flightNumber: "54",
  departureAt: "2026-09-25T00:30:00",
  arrivalAt: "2026-09-25T08:50:00",
  totalDuration: "PT7H20M",
  totalPrice: 536,
  stopCount: 0,
};

const connectingOffer: ConversationFlightOffer = {
  carrierCode: "VJ",
  flightNumber: "814",
  departureAt: "2026-09-25T17:55:00",
  arrivalAt: "2026-09-26T07:55:00",
  totalDuration: "PT13H0M",
  totalPrice: 484,
  stopCount: 1,
};

function renderWithIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe("FlightOfferCard", () => {
  it("renders carrier, flight number, and price", () => {
    renderWithIntl(<FlightOfferCard offer={nonstopOffer} currency="SGD" />);
    expect(screen.getByText("ZG 54")).toBeTruthy();
    expect(screen.getByTestId("flight-offer-card").getAttribute("data-carrier")).toBe("ZG");
  });

  it("shows a nonstop label for zero stops", () => {
    renderWithIntl(<FlightOfferCard offer={nonstopOffer} currency="SGD" />);
    expect(screen.getByText(/Nonstop/i)).toBeTruthy();
  });

  it("shows a stop count for a connecting flight", () => {
    renderWithIntl(<FlightOfferCard offer={connectingOffer} currency="SGD" />);
    expect(screen.getByText(/1 stop/i)).toBeTruthy();
  });

  it("does not render an offer id, booking link, or raw provider payload", () => {
    renderWithIntl(<FlightOfferCard offer={connectingOffer} currency="SGD" />);
    expect(screen.queryByText(/http/i)).toBeNull();
  });
});
