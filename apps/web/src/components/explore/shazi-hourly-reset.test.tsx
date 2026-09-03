import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShaziHourlyReset, msUntilNextHour } from "./shazi-hourly-reset";

afterEach(cleanup);

describe("msUntilNextHour", () => {
  it("counts to the next local top-of-the-hour", () => {
    // 13:20:30.000 → 39m30s to 14:00.
    const at = new Date(2026, 8, 4, 13, 20, 30, 0);
    expect(msUntilNextHour(at)).toBe((39 * 60 + 30) * 1000);
  });

  it("is a full hour when exactly on the hour", () => {
    const at = new Date(2026, 8, 4, 13, 0, 0, 0);
    expect(msUntilNextHour(at)).toBe(3600 * 1000);
  });

  it("rolls the day over at 23:xx", () => {
    const at = new Date(2026, 8, 4, 23, 30, 0, 0);
    expect(msUntilNextHour(at)).toBe(30 * 60 * 1000);
  });
});

describe("the on-the-hour flash", () => {
  it("shows nothing until the hour strikes", () => {
    render(<ShaziHourlyReset onReset={() => {}} msUntilFire={10_000} />);
    expect(screen.queryByRole("status", { name: "resetting" })).toBeNull();
  });

  it("flashes X + resetting on the hour, then resets", async () => {
    const onReset = vi.fn();
    render(<ShaziHourlyReset onReset={onReset} msUntilFire={10} />);

    const flash = await screen.findByRole("status", { name: "resetting" });
    expect(flash).toHaveTextContent("resetting");
    // The reset follows the flash, not the strike.
    expect(onReset).not.toHaveBeenCalled();
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1), { timeout: 4000 });
  });
});
