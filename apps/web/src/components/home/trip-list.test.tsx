import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TripList } from "./trip-list";

describe("TripList", () => {
  it("renders the current identity empty state", () => {
    render(<TripList trips={[]} />);
    expect(screen.getByRole("heading", { name: "No trips yet" })).toBeInTheDocument();
    expect(screen.getByText(/Trip creation is a later slice/)).toBeInTheDocument();
  });
});
