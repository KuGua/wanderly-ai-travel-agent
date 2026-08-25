import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl } from "@/test/render";

import { TripList } from "./trip-list";

describe("TripList (zh)", () => {
  it("renders the Chinese empty-state heading and body", () => {
    renderWithIntl(<TripList trips={[]} />, { locale: "zh" });
    expect(screen.getByRole("heading", { name: "暂无行程" })).toBeInTheDocument();
    expect(screen.getByText(/行程创建将在后续切片中提供/)).toBeInTheDocument();
  });
});