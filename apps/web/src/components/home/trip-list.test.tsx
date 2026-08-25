import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl } from "@/test/render";

import { TripList } from "./trip-list";

describe("TripList", () => {
  it("renders the current identity empty state", () => {
    renderWithIntl(<TripList trips={[]} />);
    expect(screen.getByRole("heading", { name: "No trips yet" })).toBeInTheDocument();
    expect(screen.getByText(/Trip creation is a later slice/)).toBeInTheDocument();
  });
});