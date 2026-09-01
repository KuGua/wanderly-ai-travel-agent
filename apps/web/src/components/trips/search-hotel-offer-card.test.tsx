import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import { SearchHotelOfferCard } from "@/components/trips/search-hotel-offer-card";
import type { ConversationHotelOffer } from "@/lib/api/contracts";
import enMessages from "../../../messages/en.json";

afterEach(() => cleanup());

const offer: ConversationHotelOffer = {
  propertyName: "Holiday Inn Taoyuan Airport by IHG",
  pricePerNight: 718.08,
  cancellationSummary: "Non-refundable",
};

function renderWithIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe("SearchHotelOfferCard", () => {
  it("renders property name and cancellation summary", () => {
    renderWithIntl(<SearchHotelOfferCard offer={offer} currency="CNY" />);
    expect(screen.getByText("Holiday Inn Taoyuan Airport by IHG")).toBeTruthy();
    expect(screen.getByText("Non-refundable")).toBeTruthy();
  });

  it("omits the cancellation line when the summary is null", () => {
    renderWithIntl(<SearchHotelOfferCard offer={{ ...offer, cancellationSummary: null }} currency="CNY" />);
    expect(screen.queryByText("Non-refundable")).toBeNull();
  });

  it("does not render a property id, booking link, or raw provider payload", () => {
    renderWithIntl(<SearchHotelOfferCard offer={offer} currency="CNY" />);
    expect(screen.queryByText(/http/i)).toBeNull();
  });
});
