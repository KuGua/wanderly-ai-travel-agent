import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/render";
import { WallCalendar } from "./wall-calendar";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("wall calendar", () => {
  it("shows the local leap month with Monday-first alignment and today's date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 1, 29, 12));
    renderWithIntl(<WallCalendar />, { locale: "zh" });
    const table = screen.getByRole("table", { name: "2024年2月" });
    expect(within(table).getByText("29")).toHaveAttribute("aria-current", "date");
    expect(within(table).queryByText("30")).not.toBeInTheDocument();
    const cells = within(within(table).getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent("1");
  });
  it("updates across a year boundary without reloading", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 30));
    renderWithIntl(<WallCalendar />);
    expect(screen.getByRole("table", { name: "December 2026" })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("table", { name: "January 2027" })).toBeInTheDocument();
    expect(screen.getByText("1")).toHaveAttribute("aria-current", "date");
  });
});
